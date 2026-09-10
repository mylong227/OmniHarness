import type { SessionEvent } from '../ports/event.js';
import type {
  ImageContent,
  FileAttachment,
  ModelMessage,
  ModelToolCallRef,
} from '../ports/model.js';

/** 上下文组装器：固定碎片（world_state）+ 事件日志投影 → 模型消息（model-visible means logged）。 */
export class ContextAssembler {
  /**
   * 待 flush 的 assistant 工具调用（跨事件累积）。
   * OmniHarness 把「模型返回 tool_calls」与「工具执行结果」记录为分离事件，
   * 但 OpenAI 多轮要求二者合并为 assistant(tool_calls) + tool(tool_call_id) 的配对序列，
   * 故在投影时累积 tool_call 事件，遇 tool_result 时 flush 出配对消息。
   */
  private pendingToolCalls: ModelToolCallRef[] = [];

  /**
   * 待挂载的思考文本（reasoning 事件暂存）。
   * reasoning 事件紧随其对应的 assistant 回合之前产生，投影时挂到本回合
   * 第一条 assistant 消息上（DeepSeek 思考模式要求下一轮回传 reasoning_content，
   * 缺失即 HTTP 400——2026-09-06 实测铁证）。
   */
  private pendingReasoning: string | undefined = undefined;

  /**
   * 思考模式一致性标志：一旦投影过程中出现过带 reasoning 的 assistant 消息，
   * 后续所有 assistant 消息（文本或 tool_calls 类）都必须带 reasoning_content
   * 字段（真实推理文本，或空串占位），否则 DeepSeek 思考模式返回 HTTP 400
   * （"must be passed back"，2026-09-06 实测铁证：服务端空串占位已验证 200）。
   * 初始 false：纯非思考对话不注入该字段，保持 OpenAI 等端点兼容。
   */
  private reasoningSeen = false;

  public constructor(private readonly fragments: readonly string[] = []) {}

  /**
   * 组装消息（固定碎片在前，事件投影在后）。
   * @param extraSystemFragments 动态系统碎片（如 repo-map 上下文），注入在固定碎片之后、事件之前。
   *        默认空数组，旧调用方（单参数）行为完全不变（向后兼容）。
   */
  public build(
    events: readonly SessionEvent[],
    extraSystemFragments: readonly string[] = [],
  ): ModelMessage[] {
    this.pendingToolCalls = [];
    this.pendingReasoning = undefined;
    this.reasoningSeen = false;
    const messages: ModelMessage[] = [];
    for (const fragment of this.fragments) {
      messages.push({ role: 'system', content: fragment });
    }
    for (const fragment of extraSystemFragments) {
      if (fragment !== '') {
        messages.push({ role: 'system', content: fragment });
      }
    }
    for (const event of events) {
      this.append(messages, event);
    }
    // 注：不在末尾 flush 残留 pendingToolCalls。真实链路中 tool_call 必有后续 tool_result
    // （stepRunner 即便被门禁拒绝也会补录 toolCall+toolResult），故挂起的 tool_call 只会出现在
    // 会话不完整（中途崩溃）的异常日志里，此时丢弃比发出"无配对 tool 消息的 assistant(tool_calls)"
    // 更安全（后者发给模型会触发 HTTP 400）。
    return messages;
  }

  /** 按事件类型追加对应消息。 */
  private append(messages: ModelMessage[], event: SessionEvent): void {
    switch (event.type) {
      case 'system':
        messages.push({ role: 'system', content: this.contentOf(event) });
        break;
      case 'user': {
        const images = this.imagesOf(event);
        const files = this.filesOf(event);
        const message: ModelMessage = {
          role: 'user',
          content: this.contentOf(event),
          ...(images !== undefined ? { images } : {}),
          ...(files !== undefined ? { files } : {}),
        };
        messages.push(message);
        break;
      }
      case 'assistant':
        // 若有挂起的工具调用（极少见：assistant 文本与 tool_calls 分离记录），先 flush 配对 assistant 消息。
        this.flushPendingAssistant(messages);
        // 优先用事件自身带的 reasoning（#OBS-5：stepRunner 同步塞进），退到 pendingReasoning
        // （老路径：独立 reasoning 事件 + 时序假设），二者皆无则不挂该字段。
        const payloadReasoning =
          typeof (event as { payload?: { reasoning?: unknown } }).payload?.reasoning === 'string'
            ? (event as { payload: { reasoning: string } }).payload.reasoning
            : undefined;
        const reasoning =
          payloadReasoning !== undefined && payloadReasoning !== ''
            ? payloadReasoning
            : this.pendingReasoning;
        // 思考模式一致性：一旦此前出现过 reasoning，本消息也必须带 reasoning_content
        // （真实推理文本或空串占位），缺失会触发 DeepSeek HTTP 400（"must be passed back"）。
        if (reasoning !== undefined && reasoning !== '') {
          this.reasoningSeen = true;
        }
        const reasoningContent = this.reasoningContentOf(reasoning);
        messages.push({
          role: 'assistant',
          content: this.contentOf(event),
          ...(reasoningContent !== undefined ? { reasoningContent } : {}),
        });
        this.pendingReasoning = undefined;
        break;
      case 'reasoning':
        // 思考文本暂存，挂到本回合第一条 assistant 消息（DeepSeek 思考模式回传硬要求）。
        this.pendingReasoning = this.contentOf(event);
        break;
      case 'tool_call':
        this.pendingToolCalls.push(this.toolCallOf(event));
        break;
      case 'tool_result':
        this.flushPendingAssistant(messages);
        messages.push({
          role: 'tool',
          content: this.toolContentOf(event),
          toolCallId: this.toolCallIdOf(event),
        });
        break;
      default:
        break;
    }
  }

  /** 将累积的待发工具调用 flush 为一条 assistant(tool_calls) 消息。 */
  private flushPendingAssistant(messages: ModelMessage[]): void {
    if (this.pendingToolCalls.length === 0) {
      return;
    }
    // 思考模式一致性：本回合若有过 reasoning，则 assistant(tool_calls) 也必须带
    // reasoning_content（真实文本或空串占位），否则 DeepSeek 思考模式 HTTP 400。
    if (this.pendingReasoning !== undefined && this.pendingReasoning !== '') {
      this.reasoningSeen = true;
    }
    const reasoningContent = this.reasoningContentOf(this.pendingReasoning);
    messages.push({
      role: 'assistant',
      content: '',
      toolCalls: this.pendingToolCalls,
      ...(reasoningContent !== undefined ? { reasoningContent } : {}),
    });
    this.pendingToolCalls = [];
    this.pendingReasoning = undefined;
  }

  /** 提取普通内容。 */
  private contentOf(event: SessionEvent): string {
    const payload = event.payload as { content?: string };
    return payload.content ?? '';
  }

  /** 提取用户消息附带的图像（多模态输入，#B1）；无则返回 undefined。 */
  private imagesOf(event: SessionEvent): readonly ImageContent[] | undefined {
    const payload = event.payload as { images?: readonly ImageContent[] };
    return payload.images;
  }

  /** 提取用户消息附带的文件附件（多模态输入扩展，#B5）；无则返回 undefined。 */
  private filesOf(event: SessionEvent): readonly FileAttachment[] | undefined {
    const payload = event.payload as { files?: readonly FileAttachment[] };
    return payload.files;
  }

  /** 组装工具结果内容。 */
  private toolContentOf(event: SessionEvent): string {
    const payload = event.payload as { ok: boolean; output?: string; error?: string };
    if (payload.ok) {
      return payload.output ?? '';
    }
    return `工具执行失败: ${payload.error ?? '未知错误'}`;
  }

  /** 从 tool_call 事件提取工具调用引用（EventFactory 落地为 {callId, name, args}）。 */
  private toolCallOf(event: SessionEvent): ModelToolCallRef {
    const payload = event.payload as {
      callId: string;
      name: string;
      args?: Record<string, unknown>;
    };
    return { id: payload.callId, name: payload.name, arguments: payload.args ?? {} };
  }

  /** 从 tool_result 事件提取关联的工具调用 id（EventFactory 落地为 {callId}）。 */
  private toolCallIdOf(event: SessionEvent): string | undefined {
    const payload = event.payload as { callId?: string };
    return payload.callId;
  }

  /**
   * 推导一条 assistant 消息应携带的 reasoning_content 字段值：
   * - 有真实推理文本 → 返回它，并标记思考模式已激活；
   * - 无真实文本但思考模式已激活（此前出现过 reasoning）→ 返回空串占位，维持一致；
   * - 思考模式未激活 → 返回 undefined（不注入字段，保持 OpenAI 等端点兼容）。
   */
  private reasoningContentOf(reasoning: string | undefined): string | undefined {
    if (reasoning !== undefined && reasoning !== '') {
      return reasoning;
    }
    return this.reasoningSeen ? '' : undefined;
  }
}
