import { jsonRpc } from './jsonRpc.js';
import type { Transport } from '../transport/lineTransport.js';
import type { Metrics } from '../services/metrics.js';
import type { AuditSink } from '../services/auditSink.js';
import { Id } from '../../util/id.js';
import { log } from '../../util/logger.js';
import type {
  ApprovalDecision,
  ApprovalPort,
  ApprovalRequest,
} from '../../ports/runtime/approval.js';
import type {
  AskAnswer,
  AskContext,
  AskQuestion,
  UserResponder,
} from '../../ports/runtime/userResponder.js';
import { DefaultUserResponder } from '../../adapters/user/defaultUserResponder.js';
import { QuestionAnswers } from './questionAnswers.js';
import type { EventPort } from '../../ports/runtime/eventPort.js';
import { PendingRequests, type PendingTimeout } from '../../util/concurrency/pendingRequests.js';

/** 审批上行缺省等待上限（毫秒）：超时按 deny 兑现（fail-closed）。 */
const DEFAULT_APPROVAL_TIMEOUT_MS = 120_000;

/**
 * 提问上行缺省等待上限（毫秒）：超时按「没拿到回答」兑现（fail-soft，与无人值守默认一致）。
 *
 * 为什么比审批长（300s vs 120s）：审批是一眼可判的是/否，而提问是一组带取舍说明的选项
 * （常 2~4 题），真实阅读与比较需要更长时间。为什么必须有上限：超时兜底是「人不在了
 * 就别把回合吊死」的唯一保证——没有它，`ask_user` 会像审批上行那样让回合永久挂起。
 */
const DEFAULT_QUESTION_TIMEOUT_MS = 300_000;

/** 事件/审批/提问桥依赖。 */
export interface ServerEventBridgeDeps {
  /** JSON-RPC 传输（通知下行 / 审批与提问上行）。 */
  readonly transport: Transport;
  /** 指标（thread.event 计数）。 */
  readonly metrics?: Metrics | undefined;
  /** 审计 sink（事件落盘）。 */
  readonly audit?: AuditSink | undefined;
  /**
   * 审批上行等待上限（毫秒；`0` = 不限时）。缺省 120s，可用
   * `OMNI_APPROVAL_UPLINK_TIMEOUT_MS` 覆盖。
   *
   * 为什么必须有上限（2026-09-22 修，审计 P2）：此前 `requestApproval` 只登记 resolver 后**死等**，
   * 而客户端可随时消失（关页面 / 网络断）。UI 档 `approval=ask` 下一次工具调用即让回合**永久挂起**：
   * `ToolGate` 的 `await decide` 永不 settle ⇒ 回合不返回、`activeTurns` 永久 running、
   * `POST /rpc` 悬挂、pending 表泄漏。
   */
  readonly approvalTimeoutMs?: number | undefined;
  /**
   * 提问上行等待上限（毫秒；`0` = 不限时）。缺省 300s，可用
   * `OMNI_QUESTION_UPLINK_TIMEOUT_MS` 覆盖。语义同审批超时：到点即 fail-soft 收尾。
   */
  readonly questionTimeoutMs?: number | undefined;
}

/**
 * 服务端与客户端的双向通道桥：实时事件下行（`thread.event`）与「等人回答」的上行
 * （`approval.request` → `approval.respond`、`question.request` → `question.respond`）。
 *
 * 持有两张挂起表——审批（`requestApproval` 注册 resolver，`respondApproval` 按 requestId 兑现）
 * 与提问（{@link questionPort} 注册，{@link respondQuestion} 兑现）；两者同处本类，避免 resolver
 * 表散落在 server 各处。
 *
 * **挂起不会永久存在**（2026-09-22 修审计 P2；提问沿同一口径）：每个请求都有超时兜底
 * （审批 deny / 提问 fail-soft「没拿到回答」），且传输断开时可经 {@link denyAllPending}
 * 一次性收尾全部挂起——两条路径都不让回合卡死。
 */
export class ServerEventBridge {
  /** 桥依赖（传输 / 指标 / 审计，指标与审计可缺省）。 */
  private readonly deps: ServerEventBridgeDeps;
  /** 待响应审批挂起表：requestId → 收尾通道（兑现 / 超时 deny / 断连 deny 都会移出）。 */
  private readonly pending = new PendingRequests<string, ApprovalDecision>();
  /** 待回答提问挂起表：requestId → 收尾通道。 */
  private readonly pendingQuestions = new PendingRequests<string, readonly AskAnswer[]>();
  /**
   * 待回答提问的问题清单：requestId → 本次提问。
   *
   * 为什么单开一张表：超时与断连两条兜底路径要给模型**这批问题的**占位回答
   * （`DefaultUserResponder.answersFor(questions)`），而挂起表只存 resolver、拿不到问题原文。
   */
  private readonly askedQuestions = new Map<string, readonly AskQuestion[]>();
  /** 生效的审批等待上限（毫秒；0 = 不限时）。 */
  private readonly approvalTimeoutMs: number;
  /** 生效的提问等待上限（毫秒；0 = 不限时）。 */
  private readonly questionTimeoutMs: number;

  /**
   * @param deps 传输、指标与审计（可选含审批/提问超时）
   */
  public constructor(deps: ServerEventBridgeDeps) {
    this.deps = deps;
    this.approvalTimeoutMs = ServerEventBridge.resolveApprovalTimeoutMs(deps.approvalTimeoutMs);
    this.questionTimeoutMs = ServerEventBridge.resolveQuestionTimeoutMs(deps.questionTimeoutMs);
  }

  /**
   * 事件端口：实时推送 thread.event 通知（并记录指标与审计）。
   * @returns 以 server 为名的 EventPort 适配器；emit 即向客户端下发 JSON-RPC 通知
   */
  public eventPort(): EventPort {
    return {
      name: 'server',
      emit: (event) => {
        this.deps.metrics?.recordEvent(event);
        this.deps.audit?.record({ type: event.type, sessionId: event.sessionId, detail: event });
        this.deps.transport.send(
          jsonRpc.notify('thread.event', { threadId: event.sessionId, event }),
        );
      },
    };
  }

  /**
   * 审批端口：上行至客户端。
   * @returns 以 server 为名的 ApprovalPort 适配器；decide 即发起审批上行并等待决策
   */
  public approvalPort(): ApprovalPort {
    return {
      name: 'server',
      decide: (request) => this.requestApproval(request),
    };
  }

  /**
   * 审批上行：发请求通知并等待响应；**超时按 deny 兑现**（fail-closed，绝不永久挂起）。
   * @param request 审批请求（工具名与目标，随 `approval.request` 通知下发）
   * @returns 客户端决策（allow/deny）；决策由 `approval.respond` 兑现，超时则为 deny
   */
  public async requestApproval(request: ApprovalRequest): Promise<ApprovalDecision> {
    return new Promise<ApprovalDecision>((resolve) => {
      const requestId = Id.id('apr');
      // 超时**按 deny 兑现**（不是 reject）：审批是「没有答复就不放行」，fail-closed 而非报错。
      // 刻意**不 unref**：挂起审批必须真的等到「有响应 / 超时 / 断连」三者之一才算完；
      // 让定时器保持事件循环活跃正是「不许静默丢弃」的语义。实测 unref 会让超时永不触发
      // （事件循环空闲时进程先结束，测试直接报 `Promise resolution is still pending...`），
      // 兜底形同虚设——这正是本类要防的「永久挂起」的另一种形态。
      const timeout: PendingTimeout<ApprovalDecision> | undefined =
        this.approvalTimeoutMs > 0
          ? {
              ms: this.approvalTimeoutMs,
              onTimeout: (handlers) => {
                log.warn('approval.uplink.timeout', {
                  requestId,
                  toolName: request.toolName,
                  timeoutMs: this.approvalTimeoutMs,
                });
                handlers.resolve('deny');
              },
            }
          : undefined;
      this.pending.register(requestId, { resolve }, timeout);
      this.deps.transport.send(
        jsonRpc.notify('approval.request', {
          requestId,
          toolName: request.toolName,
          target: request.target,
        }),
      );
    });
  }

  /**
   * 响应审批上行：按 requestId 兑现挂起的 resolver（未知 id 静默，重复响应幂等）。
   * @param params `{ requestId: string; decision?: unknown }`
   * @returns `{ ok: true }`
   */
  public respondApproval(params: Record<string, unknown>): unknown {
    const requestId = String(params['requestId'] ?? '');
    this.pending.settle(requestId, params['decision'] === 'allow' ? 'allow' : 'deny');
    return { ok: true };
  }

  /**
   * 提问端口：上行至客户端（浏览器里是那张可作答的提问卡）。
   * @returns 以 server 为名的 UserResponder 适配器；ask 即发起提问上行并等待回答
   */
  public questionPort(): UserResponder {
    return {
      name: 'server',
      ask: (questions, context) => this.requestQuestion(questions, context),
    };
  }

  /**
   * 提问上行：发 `question.request` 通知并等待 `question.respond`。
   *
   * **超时按「没拿到回答」兑现**（fail-soft，与 `DefaultUserResponder` 同一文案）：
   * 提问不是门禁，人不在时应当带着「未取得回答」继续跑，而不是把回合吊死——这正是修复
   * 「Web 端只能看、不能答，回合永久卡在 ask_user」的那个缺陷（2026-10-08）。
   * @param questions 本次提问（原样进通知，并作为超时兜底与答案校验的基准）。
   * @param context 提问上下文（会话 id；缺省即「无归属」）。
   * @returns 与 questions 同序的回答；超时或客户端全部断开时为占位回答。
   */
  public async requestQuestion(
    questions: readonly AskQuestion[],
    context?: AskContext,
  ): Promise<readonly AskAnswer[]> {
    const requestId = Id.id('qst');
    this.askedQuestions.set(requestId, questions);
    return new Promise<readonly AskAnswer[]>((resolve) => {
      const timeout: PendingTimeout<readonly AskAnswer[]> | undefined =
        this.questionTimeoutMs > 0
          ? {
              ms: this.questionTimeoutMs,
              onTimeout: () => {
                // 刻意**不 unref**：与审批超时同理，挂起的提问必须真的等到
                // 「有回答 / 超时 / 断连」三者之一，不许静默丢弃。
                log.warn('question.uplink.timeout', {
                  requestId,
                  count: questions.length,
                  timeoutMs: this.questionTimeoutMs,
                });
                this.askedQuestions.delete(requestId);
                resolve(DefaultUserResponder.answersFor(questions));
              },
            }
          : undefined;
      this.pendingQuestions.register(
        requestId,
        {
          resolve: (answers) => {
            this.askedQuestions.delete(requestId);
            resolve(answers);
          },
        },
        timeout,
      );
      this.deps.transport.send(
        jsonRpc.notify('question.request', {
          requestId,
          sessionId: context?.sessionId ?? null,
          questions,
          timeoutMs: this.questionTimeoutMs,
        }),
      );
    });
  }

  /**
   * 响应提问上行：校验答案并按 requestId 兑现挂起的 resolver。
   *
   * 未知 requestId 或非法答案都**不兑现**（保留挂起，允许客户端改正后重提）——静默吞掉会让
   * UI 以为已提交、而回合永远等下去；这是本类要防的「永久挂起」的另一种形态。
   * @param params `{ requestId: string; answers: unknown }`
   * @returns `{ ok: true }`，或 `{ ok: false, error }`（未知请求 / 答案不合法）
   */
  public respondQuestion(params: Record<string, unknown>): unknown {
    const requestId = String(params['requestId'] ?? '');
    const questions = this.askedQuestions.get(requestId);
    if (questions === undefined) {
      return { ok: false, error: 'unknown_request' };
    }
    const parsed = QuestionAnswers.parse(params['answers'], questions);
    if (!parsed.ok) {
      log.warn('question.uplink.rejected', { requestId, error: parsed.error });
      return { ok: false, error: parsed.error };
    }
    this.pendingQuestions.settle(requestId, parsed.answers);
    return { ok: true };
  }

  /**
   * 一次性兑现**全部**挂起提问为「未拿到回答」（fail-soft）——由传输层在客户端断开时调用。
   *
   * 断连是**确定的**不会再有回答的信号，故不必白等一整个超时窗口；
   * 收尾文案与超时路径同源（{@link DefaultUserResponder.answersFor}），两条路径不给模型两套说法。
   * @param reason 断开原因（仅记日志，便于事后归因）
   * @returns 被收尾的提问条数
   */
  public failAllQuestions(reason: string): number {
    let settled = 0;
    for (const [requestId, questions] of [...this.askedQuestions]) {
      if (this.pendingQuestions.settle(requestId, DefaultUserResponder.answersFor(questions))) {
        settled += 1;
      }
      this.askedQuestions.delete(requestId);
    }
    if (settled > 0) {
      log.warn('question.uplink.disconnected', { reason, pending: settled });
    }
    return settled;
  }

  /**
   * 一次性收尾**全部**挂起上行（审批 deny + 提问未拿到回答）——由传输层在客户端断开时调用。
   *
   * 为什么要这条路径：超时兜底有延迟（审批 120s / 提问 300s），而「页面关闭」是**确定的**
   * 不会再有响应的信号；立即收尾可让回合马上继续，而不是白等一整个超时窗口。
   * @param reason 断开原因（仅记日志，便于事后归因）
   * @returns 被收尾的挂起条数（审批 + 提问）
   */
  public denyAllPending(reason: string): number {
    const approvals = this.pending.size();
    const questions = this.failAllQuestions(reason);
    if (approvals > 0) {
      log.warn('approval.uplink.disconnected', { reason, pending: approvals });
      this.pending.settleAll('deny');
    }
    return approvals + questions;
  }

  /**
   * 当前挂起提问条数（观测/测试用）。
   * @returns 挂起提问条数
   */
  public pendingQuestionCount(): number {
    return this.pendingQuestions.size();
  }

  /**
   * 当前挂起审批条数（观测/测试用）。
   * @returns 挂起条数
   */
  public pendingApprovalCount(): number {
    return this.pending.size();
  }

  /**
   * 审批上行超时解析：显式入参 > env `OMNI_APPROVAL_UPLINK_TIMEOUT_MS` > 缺省 120s；
   * `0`/负数/非有限表示**不限时**（保留旧行为，供确实需要人工长时间决策的部署显式选择）。
   * @param explicit 显式入参（毫秒）
   * @returns 生效超时毫秒数（0 = 不限时）
   */
  public static resolveApprovalTimeoutMs(explicit?: number): number {
    if (typeof explicit === 'number' && Number.isFinite(explicit)) {
      return explicit > 0 ? Math.floor(explicit) : 0;
    }
    const raw = process.env['OMNI_APPROVAL_UPLINK_TIMEOUT_MS'];
    if (raw !== undefined && raw.trim() !== '') {
      const parsed = Number(raw);
      if (Number.isFinite(parsed)) {
        return parsed > 0 ? Math.floor(parsed) : 0;
      }
    }
    return DEFAULT_APPROVAL_TIMEOUT_MS;
  }

  /**
   * 提问上行超时解析：显式入参 > env `OMNI_QUESTION_UPLINK_TIMEOUT_MS` > 缺省 300s；
   * `0`/负数/非有限表示**不限时**（供确实需要人工长时间作答的部署显式选择）。
   * @param explicit 显式入参（毫秒）
   * @returns 生效超时毫秒数（0 = 不限时）
   */
  public static resolveQuestionTimeoutMs(explicit?: number): number {
    if (typeof explicit === 'number' && Number.isFinite(explicit)) {
      return explicit > 0 ? Math.floor(explicit) : 0;
    }
    const raw = process.env['OMNI_QUESTION_UPLINK_TIMEOUT_MS'];
    if (raw !== undefined && raw.trim() !== '') {
      const parsed = Number(raw);
      if (Number.isFinite(parsed)) {
        return parsed > 0 ? Math.floor(parsed) : 0;
      }
    }
    return DEFAULT_QUESTION_TIMEOUT_MS;
  }
}
