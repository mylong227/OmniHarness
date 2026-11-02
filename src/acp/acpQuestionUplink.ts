import type {
  AcpElicitationRequest,
  AcpElicitationResponse,
  AcpPermissionOutcome,
  AcpPermissionRequest,
} from './acpProtocol.ts';
import type {
  AskAnswer,
  AskContext,
  AskOption,
  AskQuestion,
  UserResponder,
} from '../ports/runtime/userResponder.ts';

/**
 * ACP 提问上行（2026-11-01 接线收口；2026-11-02 补 elicitation）。
 *
 * 三种题型走两条原语，**不伪装**能力：
 * - 单选题 → `session/request_permission`（协议唯一的单选点选原语）；
 * - 多选 / 开放题 → `elicitation/create`（ACP v1 稳定原语，form 模式）；
 *   仅当 Client 在 initialize 里显式声明 `elicitation.form` 时才走这条路；
 * - 客户端没有 form 能力时，多选 / 开放题仍返回空选择占位（协议层没有别的可承载原语）。
 *
 * ## 为什么是 request_permission + elicitation
 *
 * `request_permission` 只能回传一个 optionId，用来承载多选/自由文本会歪曲语义；
 * ACP v1 的 elicitation form 支持 `type: 'array'`（多选）与 `type: 'string'`（开放题），
 * 正好覆盖 `ask_user` 的两种剩余题型。schema 只用扁平原语，不请求任何敏感字段。
 *
 * 超时 / 会话取消（registry 的 request id 追踪使 cancel 能顺带收掉在途提问）→
 * `cancelled` / `cancel` → 空选择，与无人值守兜底同语义。
 */

/** AcpServer 注入给本类的原语（全部是对既有机制的薄封装）。 */
export interface AcpQuestionUplinkDeps {
  /** 权限上行等待上限（毫秒；0 = 不限时，与审批口径一致）。 */
  readonly timeoutMs: number;
  /** Client 是否声明了 elicitation form 能力。 */
  readonly supportsElicitationForm: boolean;
  /** 分配一个 JSON-RPC 请求 id（与服务端请求共用同一 id 空间，响应路由才可达）。 */
  readonly allocateId: () => number;
  /** 发出 session/request_permission 请求。 */
  readonly sendRequest: (id: number, permission: AcpPermissionRequest) => void;
  /** 发出 elicitation/create 请求。 */
  readonly sendElicitation: (id: number, request: AcpElicitationRequest) => void;
  /**
   * 登记等待中的权限请求（服务端 pending 表；onClientResponse 按 id 兑现）。
   * `timeout` 的「刻意不 unref」语义由服务端表负责，本类只组装。
   */
  readonly registerPending: (id: number, resolve: (outcome: AcpPermissionOutcome) => void) => void;
  /** 登记等待中的 elicitation 请求。 */
  readonly registerElicitationPending: (
    id: number,
    resolve: (response: AcpElicitationResponse) => void,
  ) => void;
  /** 登记进会话的在途权限 id 表（使 session/cancel 能顺带收掉在途提问）。 */
  readonly trackPermission: (sessionId: string, id: number) => void;
  /** 移出在途权限 id 表。 */
  readonly untrackPermission: (sessionId: string, id: number) => void;
}

/** ACP 面的提问上行：单选走权限原语，多选/开放题走 elicitation form。 */
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
   * 单题上行：单选走 request_permission；多选/开放题走 elicitation（能力未声明则占位）。
   * @param sessionId 会话 id（取消追踪归属；可为空串）。
   * @param question 单题。
   * @returns 该题的回答（selected 为所选 label，custom 为开放题自由文本）。
   */
  private async askOne(sessionId: string, question: AskQuestion): Promise<AskAnswer> {
    const empty: AskAnswer = { id: question.id, selected: [] };
    const options = question.options ?? [];
    if (options.length === 0) return this.askOpen(sessionId, question, empty);
    if (question.multiSelect === true) return this.askMulti(sessionId, question, options, empty);
    const id = this.deps.allocateId();
    this.deps.trackPermission(sessionId, id);
    const permission: AcpPermissionRequest = {
      sessionId,
      toolCall: {
        toolCallId: `ask-${String(id)}`,
        title: AcpQuestionUplink.titleOf(question),
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

  /**
   * 多选题：elicitation form 的 array + items.enum；只接受提供过的选项标签。
   * @param sessionId 会话 id。
   * @param question 多选题。
   * @param options 选项集。
   * @param empty 空回答（能力不足 / 取消时复用）。
   * @returns 回答。
   */
  private async askMulti(
    sessionId: string,
    question: AskQuestion,
    options: readonly AskOption[],
    empty: AskAnswer,
  ): Promise<AskAnswer> {
    if (!this.deps.supportsElicitationForm) return empty;
    const labels = options.map((option) => option.label);
    const response = await this.requestElicitation(sessionId, {
      sessionId,
      mode: 'form',
      message: AcpQuestionUplink.titleOf(question),
      requestedSchema: {
        type: 'object',
        properties: {
          answer: {
            type: 'array',
            title: question.question,
            items: { type: 'string', enum: labels },
            minItems: 0,
          },
        },
        required: ['answer'],
      },
    });
    if (response.action !== 'accept') return empty;
    const raw = response.content?.['answer'];
    const selected = Array.isArray(raw)
      ? raw.filter((value): value is string => typeof value === 'string' && labels.includes(value))
      : [];
    return { id: question.id, selected };
  }

  /**
   * 开放题：elicitation form 的 string；空白文本等价未作答。
   * @param sessionId 会话 id。
   * @param question 开放题。
   * @param empty 空回答（能力不足 / 取消时复用）。
   * @returns 回答（custom 为自由文本）。
   */
  private async askOpen(
    sessionId: string,
    question: AskQuestion,
    empty: AskAnswer,
  ): Promise<AskAnswer> {
    if (!this.deps.supportsElicitationForm) return empty;
    const response = await this.requestElicitation(sessionId, {
      sessionId,
      mode: 'form',
      message: AcpQuestionUplink.titleOf(question),
      requestedSchema: {
        type: 'object',
        properties: {
          answer: { type: 'string', title: question.question },
        },
        required: ['answer'],
      },
    });
    if (response.action !== 'accept') return empty;
    const raw = response.content?.['answer'];
    const text = typeof raw === 'string' ? raw.trim() : '';
    return text === '' ? empty : { id: question.id, selected: [], custom: text };
  }

  /**
   * 发 elicitation/create 并等待响应；超时/取消由服务端 pending 表兑现。
   * @param sessionId 会话 id。
   * @param request 表单请求。
   * @returns 用户动作与内容。
   */
  private async requestElicitation(
    sessionId: string,
    request: AcpElicitationRequest,
  ): Promise<AcpElicitationResponse> {
    const id = this.deps.allocateId();
    this.deps.trackPermission(sessionId, id);
    try {
      return await new Promise<AcpElicitationResponse>((resolve) => {
        this.deps.registerElicitationPending(id, resolve);
        this.deps.sendElicitation(id, request);
      });
    } finally {
      this.deps.untrackPermission(sessionId, id);
    }
  }

  /**
   * 提问标题（header 前缀 + 多选标记）；elicitation 的 message 与 permission 的 title 共用。
   * @param question 单题。
   * @returns 展示标题。
   */
  private static titleOf(question: AskQuestion): string {
    const prefix =
      question.header !== undefined && question.header !== '' ? `【${question.header}】` : '';
    const suffix = question.multiSelect === true ? '（可多选）' : '';
    return prefix + question.question + suffix;
  }
}
