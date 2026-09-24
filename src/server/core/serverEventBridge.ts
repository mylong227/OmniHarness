import { jsonRpc } from './jsonRpc.js';
import type { Transport } from '../transport/lineTransport.js';
import type { Metrics } from '../services/metrics.js';
import type { AuditSink } from '../services/auditSink.js';
import { id } from '../../util/id.js';
import { log } from '../../util/logger.js';
import type {
  ApprovalDecision,
  ApprovalPort,
  ApprovalRequest,
} from '../../ports/runtime/approval.js';
import type { EventPort } from '../../ports/runtime/eventPort.js';
import { PendingRequests, type PendingTimeout } from '../../util/pendingRequests.js';

/** 审批上行缺省等待上限（毫秒）：超时按 deny 兑现（fail-closed）。 */
const DEFAULT_APPROVAL_TIMEOUT_MS = 120_000;

/**
 * 审批上行超时解析：显式入参 > env `OMNI_APPROVAL_UPLINK_TIMEOUT_MS` > 缺省 120s；
 * `0`/负数/非有限表示**不限时**（保留旧行为，供确实需要人工长时间决策的部署显式选择）。
 * @param explicit 显式入参（毫秒）
 * @returns 生效超时毫秒数（0 = 不限时）
 */
function resolveApprovalTimeoutMs(explicit?: number): number {
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

/** 事件/审批桥依赖。 */
export interface ServerEventBridgeDeps {
  /** JSON-RPC 传输（通知下行 / 审批上行）。 */
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
}

/**
 * 服务端与客户端的双向通道桥：实时事件下行（`thread.event`）与审批请求上行
 * （`approval.request` → `approval.respond`）。
 *
 * 持有「待响应审批」挂起表——`requestApproval` 注册 resolver，`respondApproval`
 * 按 requestId 兑现；两者同处本类，避免 resolver 表散落在 server 各处。
 *
 * **挂起不会永久存在**（2026-09-22 修）：每个请求都有超时兜底（deny，fail-closed），
 * 且传输断开时可经 {@link denyAllPending} 一次性兑现全部挂起——两条路径都不让回合卡死。
 */
export class ServerEventBridge {
  /** 桥依赖（传输 / 指标 / 审计，指标与审计可缺省）。 */
  private readonly deps: ServerEventBridgeDeps;
  /** 待响应审批挂起表：requestId → 收尾通道（兑现 / 超时 deny / 断连 deny 都会移出）。 */
  private readonly pending = new PendingRequests<string, ApprovalDecision>();
  /** 生效的审批等待上限（毫秒；0 = 不限时）。 */
  private readonly approvalTimeoutMs: number;

  /**
   * @param deps 传输、指标与审计（可选含审批超时）
   */
  public constructor(deps: ServerEventBridgeDeps) {
    this.deps = deps;
    this.approvalTimeoutMs = resolveApprovalTimeoutMs(deps.approvalTimeoutMs);
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
      const requestId = id('apr');
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
   * 一次性兑现**全部**挂起审批为 deny（fail-closed）——由传输层在客户端断开时调用。
   *
   * 为什么要这条路径：超时兜底有延迟（默认 120s），而「页面关闭」是**确定的**不会再有响应的信号；
   * 立即兑现可让回合马上收尾，而不是白等一整个超时窗口。
   * @param reason 断开原因（仅记日志，便于事后归因）
   * @returns 被兑现的挂起条数
   */
  public denyAllPending(reason: string): number {
    const count = this.pending.size();
    if (count === 0) {
      return 0;
    }
    log.warn('approval.uplink.disconnected', { reason, pending: count });
    this.pending.settleAll('deny');
    return count;
  }

  /**
   * 当前挂起审批条数（观测/测试用）。
   * @returns 挂起条数
   */
  public pendingApprovalCount(): number {
    return this.pending.size();
  }
}
