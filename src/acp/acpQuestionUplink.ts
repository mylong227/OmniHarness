import type { AcpPermissionOutcome, AcpPermissionRequest } from './acpProtocol.ts';
import type {
  AskAnswer,
  AskContext,
  AskQuestion,
  UserResponder,
} from '../ports/runtime/userResponder.ts';

/**
 * ACP 提问上行（2026-11-01 接线收口）：把 `ask_user` 的**单选题**映射为
 * `session/request_permission`，用户在 ACP 客户端（如 Zed）点选的选项即答案。
 *
 * ## 为什么是 request_permission
 *
 * ACP 协议里唯一的「向人要一个选择」原语就是 `session/request_permission`（审批走它）。
 * 提问复用同一原语：选项 label 即 optionId，回传的 optionId 即所选 label——`ask_user`
 * 的答案契约（`selected` 必须是提供过的选项标签）恰好闭合。选项 kind 统一用
 * `allow_once`（协议无「中性」档；四值里它最少暗示否定/持久语义）。
 *
 * ## 诚实边界（不歪曲映射）
 *
 * - **多选题**与**无选项的开放题**无法经 request_permission 承载（前者是单选原语，后者
 *   收不了自由文本）：直接返回空选择占位，**不**伪装成可作答。题面本身已由
 *   {@link AcpEventMapper} 的 question 映射对客户端可见。
 * - 超时 / 会话取消（registry 的 permissionId 追踪使 cancel 能顺带收掉在途提问）→
 *   `cancelled` → 空选择，与无人值守兜底同语义。
 *
 * 为什么做成协作类而不是 AcpServer 的方法：AcpServer 已顶「上帝类」25 方法闸；
 * 本类经构造注入复用服务端的 pending 表 / 请求 id / 取消追踪，不另起一套并行机制。
 */

/** AcpServer 注入给本类的原语（全部是对既有机制的薄封装）。 */
export interface AcpQuestionUplinkDeps {
  /** 权限上行等待上限（毫秒；0 = 不限时，与审批口径一致）。 */
  readonly timeoutMs: number;
  /** 分配一个 JSON-RPC 请求 id（与服务端请求共用同一 id 空间，响应路由才可达）。 */
  readonly allocateId: () => number;
  /** 发出 session/request_permission 请求。 */
  readonly sendRequest: (id: number, permission: AcpPermissionRequest) => void;
  /**
   * 登记等待中的请求（服务端 pending 表；onClientResponse 按 id 兑现）。
   * `timeout` 的「刻意不 unref」语义由服务端表负责，本类只组装。
   */
  readonly registerPending: (id: number, resolve: (outcome: AcpPermissionOutcome) => void) => void;
  /** 登记进会话的在途权限 id 表（使 session/cancel 能顺带收掉在途提问）。 */
  readonly trackPermission: (sessionId: string, id: number) => void;
  /** 移出在途权限 id 表。 */
  readonly untrackPermission: (sessionId: string, id: number) => void;
}

/** ACP 面的提问上行：单选题经 request_permission 回传，其余诚实占位。 */
export class AcpQuestionUplink {
  /** 服务端注入的原语。 */
  private readonly deps: AcpQuestionUplinkDeps;

  /**
   * @param deps 服务端注入的原语（pending 表 / 请求 id / 取消追踪的薄封装）。
   */
  public constructor(deps: AcpQuestionUplinkDeps) {
    this.deps = deps;
  }

  /**
   * 取 UserResponder 视图（装配进 AcpSessionOptions.userResponder）。
   * @returns 以 acp-question 为名的回答端口。
   */
  public responder(): UserResponder {
    return {
      name: 'acp-question',
      ask: (questions, context) => this.ask(questions, context),
    };
  }

  /**
   * 逐题上行并收集回答（多题顺序问，避免客户端并发弹窗打架）。
   * @param questions 本次提问（原样来自 ask_user 工具）。
   * @param context 提问上下文（sessionId 用于取消追踪归属）。
   * @returns 与 questions 同序的回答；不可承载的题为空选择。
   */
  private async ask(
    questions: readonly AskQuestion[],
    context?: AskContext,
  ): Promise<readonly AskAnswer[]> {
    const sessionId = context?.sessionId ?? '';
    const answers: AskAnswer[] = [];
    for (const question of questions) {
      answers.push(await this.askOne(sessionId, question));
    }
    return answers;
  }

  /**
   * 单题上行：单选题发 request_permission 等点选；多选/开放题占位空选择。
   * @param sessionId 会话 id（取消追踪归属；可为空串）。
   * @param question 单题。
   * @returns 该题的回答（selected 为所选 label，或空数组=未答）。
   */
  private async askOne(sessionId: string, question: AskQuestion): Promise<AskAnswer> {
    const empty: AskAnswer = { id: question.id, selected: [] };
    const options = question.options ?? [];
    if (options.length === 0 || question.multiSelect === true) return empty;
    const id = this.deps.allocateId();
    this.deps.trackPermission(sessionId, id);
    const permission: AcpPermissionRequest = {
      sessionId,
      toolCall: {
        toolCallId: `ask-${String(id)}`,
        title:
          (question.header !== undefined && question.header !== ''
            ? `【${question.header}】`
            : '') + question.question,
        name: 'ask_user',
        kind: 'other',
        status: 'pending',
      },
      options: options.map((option) => ({
        optionId: option.label,
        name: option.label,
        kind: 'allow_once',
      })),
    };
    try {
      const outcome = await new Promise<AcpPermissionOutcome>((resolve) => {
        this.deps.registerPending(id, resolve);
        this.deps.sendRequest(id, permission);
      });
      if (outcome.outcome !== 'selected' || outcome.optionId === '') return empty;
      return { id: question.id, selected: [outcome.optionId] };
    } finally {
      this.deps.untrackPermission(sessionId, id);
    }
  }
}
