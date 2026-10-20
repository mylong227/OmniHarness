import { readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import type { SessionEvent } from '../ports/runtime/event.ts';
import type {
  ImageContent,
  FileAttachment,
  ModelMessage,
  ModelToolCallRef,
} from '../ports/model/model.ts';
import { COMPACTION_MARKER } from './contextCompactor.ts';
import { ContextImageBudget } from './contextImageBudget.ts';

/** 组装器增量投影缓存（2026-10-21）：事件只追加时复用已投影消息，避免每步 O(全量事件)。 */
interface ProjectionCache {
  readonly events: readonly SessionEvent[];
  readonly messages: ModelMessage[];
  readonly extra: readonly string[];
  readonly pendingToolCalls: ModelToolCallRef[];
  readonly pendingReasoning: string | undefined;
  readonly reasoningSeen: boolean;
  readonly pendingAttachments: FileAttachment[];
}

/** 上下文组装器：固定碎片（world_state）+ 事件日志投影 → 模型消息（model-visible means logged）。 */
export class ContextAssembler {
  /**
   * 回灌给模型的回合 diff 上限（字符）：8000。
   *
   * 依据：足以覆盖「改了哪几个文件、哪些 hunk」的复核需求，又不至于让一次大重构的 diff
   * 挤掉后续工具结果所需的上下文预算。
   */
  public static readonly MAX_DIFF_CHARS = 8_000;

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

  /**
   * 工具结果里携带的文件附件（P2-⑬，`view_image` 等）。
   *
   * flush 时机（2026-10-03 修）：**攒到本工具轮结束**（下一条非 `tool_result` 事件到来前）再发。
   * 不能插进 tool 消息中间：OpenAI 兼容端点要求每条 `role:'tool'` 消息都必须紧跟在其配对的
   * `assistant(tool_calls)` 之后，同回合第二条 tool 消息前面插入 user 消息即 HTTP 400；
   * 但也不能像旧实现那样攒到**整段对话投影完**——第 3 轮产生的附件会落在最后一条 assistant
   * 回复之后，与产生它的请求相隔十几个回合，模型把图片关联到当前问题而非当初请求。
   * 「下一条非 tool_result 事件」= 本轮工具消息已全部发完、且尚未开启下一轮 ⇒ 附件紧跟其轮次，
   * 且不破坏 `assistant(tool_calls) ↔ tool` 配对。
   */
  private pendingAttachments: FileAttachment[] = [];

  /** 增量投影缓存：事件前缀未变时复用上一轮投影（2026-10-21）。 */
  private projectionCache: ProjectionCache | undefined;

  public constructor(
    private readonly fragments: readonly string[] = [],
    /**
     * 外置附件根目录（`StoragePort.location`，即 sessions 目录）。
     * `FileAttachment.path` 为相对路径时，按它拼绝对路径水合；缺省时只认绝对路径。
     */
    private readonly attachmentRoot?: string,
  ) {}

  /**
   * 组装消息（固定碎片在前，事件投影在后）。
   * @param extraSystemFragments 动态系统碎片（如 repo-map 上下文），注入在固定碎片之后、事件之前。
   *        默认空数组，旧调用方（单参数）行为完全不变（向后兼容）。
   */
  public build(
    events: readonly SessionEvent[],
    extraSystemFragments: readonly string[] = [],
  ): ModelMessage[] {
    const cached = this.reusableProjection(events, extraSystemFragments);
    let messages: ModelMessage[];
    let start: number;
    if (cached !== undefined) {
      // 复用已投影前缀：只追加 cache 之后的新事件。事件日志只追加（回卷会让长度变小/
      // 前缀对象变化 ⇒ reusable 判否），所以「前缀同一批事件对象」是安全判据。
      messages = [...cached.messages];
      this.pendingToolCalls = [...cached.pendingToolCalls];
      this.pendingReasoning = cached.pendingReasoning;
      this.reasoningSeen = cached.reasoningSeen;
      this.pendingAttachments = [...cached.pendingAttachments];
      start = cached.events.length;
    } else {
      this.pendingToolCalls = [];
      this.pendingReasoning = undefined;
      this.reasoningSeen = false;
      this.pendingAttachments = [];
      messages = [];
      for (const fragment of this.fragments) {
        messages.push({ role: 'system', content: fragment });
      }
      for (const fragment of extraSystemFragments) {
        if (fragment !== '') {
          messages.push({ role: 'system', content: fragment });
        }
      }
      start = 0;
    }
    for (let i = start; i < events.length; i += 1) {
      const event = events[i];
      if (event !== undefined) this.append(messages, event);
    }
    // 注：不在末尾 flush 残留 pendingToolCalls。真实链路中 tool_call 必有后续 tool_result
    // （stepRunner 即便被门禁拒绝也会补录 toolCall+toolResult），故挂起的 tool_call 只会出现在
    // 会话不完整（中途崩溃）的异常日志里，此时丢弃比发出"无配对 tool 消息的 assistant(tool_calls)"
    // 更安全（后者发给模型会触发 HTTP 400）。
    this.flushPendingAttachments(messages);
    ContextImageBudget.retainRecent(messages);
    this.projectionCache = {
      events: [...events],
      messages: [...messages],
      extra: [...extraSystemFragments],
      pendingToolCalls: [...this.pendingToolCalls],
      pendingReasoning: this.pendingReasoning,
      reasoningSeen: this.reasoningSeen,
      pendingAttachments: [...this.pendingAttachments],
    };
    return messages;
  }

  /**
   * 判断上一轮投影能否复用（事件前缀对象同一 + 动态片段一致）。
   * @param events 本轮完整事件。
   * @param extra 本轮动态系统片段。
   * @returns 可复用缓存；不可复用为 undefined。
   */
  private reusableProjection(
    events: readonly SessionEvent[],
    extra: readonly string[],
  ): ProjectionCache | undefined {
    const cached = this.projectionCache;
    if (cached === undefined) return undefined;
    if (cached.extra.length !== extra.length) return undefined;
    for (let i = 0; i < extra.length; i += 1) {
      if (cached.extra[i] !== extra[i]) return undefined;
    }
    // 只在**确实追加了新事件**时复用：同长度重建虽然更慢，但能看见头部事件被原地改写
    // （测试会这样构造前缀漂移；生产事件虽是只追加，也不该把契约押在「对象不会被原地改」上）。
    if (events.length <= cached.events.length) return undefined;
    for (let i = 0; i < cached.events.length; i += 1) {
      if (events[i] !== cached.events[i]) return undefined;
    }
    return cached;
  }

  /** 按事件类型追加对应消息。
   * @returns 无返回值。
   */
  private append(messages: ModelMessage[], event: SessionEvent): void {
    // 工具轮结束（下一条非 tool_result 事件）即 flush 附件：紧跟其轮次，见 pendingAttachments 说明。
    if (event.type !== 'tool_result' && this.pendingAttachments.length > 0) {
      this.flushPendingAttachments(messages);
    }
    switch (event.type) {
      case 'system': {
        const content = this.contentOf(event);
        // 压缩游标是**内部记账**（供 `StepContextBuilder.restoreCompactionState` 崩溃恢复），
        // 不是给模型的内容：投影时剔除。不剔除的实害有两层——模型每步多读一份与摘要正文
        // 重复的副本（游标正文就是全文摘要），并读到 `OMNI_COMPACTION_V1 upTo=… hash=…`
        // 这类内部标记（纯噪声 + 暴露内部实现）。事件本身仍留在日志里，恢复逻辑不受影响。
        if (!content.startsWith(COMPACTION_MARKER)) {
          messages.push({ role: 'system', content });
        }
        break;
      }
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
        this.appendAssistant(messages, event);
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
        this.collectAttachments(event);
        break;
      case 'turn_diff': {
        // 模型**必须看到自己改了什么**（2026-09-26 审计 A7）：`turn_diff` 原先只广播给 UI，
        // 投影时被 default 分支丢弃 ⇒ 模型无法复核本回合的实际改动，只能凭记忆断言「已改好」。
        // 这里以 user 消息回灌（带总量上限，避免大 diff 撑爆上下文）。
        //
        // 2026-10-03 修：字段必须是 `payload.diff`——`EventFactory.turnDiff` 落地的 payload 形状
        // 就是 `{ diff }`，此前读 `contentOf`（`payload.content`）恒得空串，`appendTurnDiff`
        // 的空串卫语句直接返回 ⇒ A7 声称的修复实际一条 diff 都没到过模型（单测用错误形状
        // `{ content }` 构造事件，假绿掩盖了死投影）。
        this.appendTurnDiff(messages, this.diffOf(event));
        break;
      }
      default:
        break;
    }
  }

  /**
   * 追加 assistant 文本消息（含思考模式一致性回传，DeepSeek 硬要求）。
   * @param messages 已组装的消息序列（原地追加）。
   * @param event assistant 事件。
   * @returns 无返回值。
   */
  private appendAssistant(messages: ModelMessage[], event: SessionEvent): void {
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
  }

  /** 将累积的待发工具调用 flush 为一条 assistant(tool_calls) 消息。
   * @returns 无返回值。
   */
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

  /**
   * 把回合 diff 以 user 消息回灌（空 diff 不产生任何消息）。
   * @param messages 已组装的消息序列（原地追加）。
   * @param diff 原始 unified diff 文本。
   * @returns 无返回值。
   */
  private appendTurnDiff(messages: ModelMessage[], diff: string): void {
    if (diff.trim() === '') {
      return;
    }
    messages.push({
      role: 'user',
      content: `[上一回合的实际改动 diff]\n${ContextAssembler.boundDiff(diff)}`,
    });
  }

  /** 提取普通内容。 */
  private contentOf(event: SessionEvent): string {
    const payload = event.payload as { content?: string };
    return payload.content ?? '';
  }

  /**
   * 提取回合 diff（`EventFactory.turnDiff` 落地的 payload 字段是 `diff`，不是 `content`）。
   * @param event turn_diff 事件。
   * @returns diff 文本；形状不符（异常持久化数据）时为空串（回灌卫语句会跳过）。
   */
  private diffOf(event: SessionEvent): string {
    const payload = event.payload as { diff?: string };
    return payload.diff ?? '';
  }

  /**
   * 把回合 diff 截到上限（保留**头部**：diff 的头部含文件与 hunk 起点，是最需要复核的部分）。
   * @param diff 原始 unified diff。
   * @returns 截断后的文本（超限时附截断说明）。
   */
  private static boundDiff(diff: string): string {
    const limit = ContextAssembler.MAX_DIFF_CHARS;
    if (diff.length <= limit) {
      return diff;
    }
    return `${diff.slice(0, limit)}\n…（diff 已截断，共 ${String(diff.length)} 字符）`;
  }

  /** 提取用户消息附带的图像（多模态输入，#B1）；无则返回 undefined。 */
  private imagesOf(event: SessionEvent): readonly ImageContent[] | undefined {
    const payload = event.payload as { images?: readonly ImageContent[] };
    return payload.images;
  }

  /** 提取用户消息附带的文件附件（多模态输入扩展，#B5）；无则返回 undefined。 */
  private filesOf(event: SessionEvent): readonly FileAttachment[] | undefined {
    const payload = event.payload as { files?: readonly FileAttachment[] };
    const files = payload.files;
    if (files === undefined || files.length === 0) {
      return files;
    }
    return files.map((file) => this.hydrateAttachment(file));
  }

  /**
   * 把外置附件（只有 `path`）水合成 base64（2026-10-20）。
   *
   * 落盘时大附件被 `SessionAttachmentSpiller` 移出 JSONL；回放/续跑时模型仍需要字节，
   * 故在**投影**这一步按路径读回。路径口径：
   *  - 相对路径（`attachments/<sha>.<ext>`）⇒ 用 `StoragePort.location` 拼绝对；
   *  - 绝对路径（旧存档）⇒ 原样使用。
   * 读失败（文件被清理/移走/跨机器）时保持原样——模型至少还能看到附件信封
   * （文件名 + MIME），不会因此让整条历史组装失败。
   *
   * @param file 附件（可能含 path 无 data）。
   * @returns 水合后的附件；无需/无法水合时原样返回。
   */
  private hydrateAttachment(file: FileAttachment): FileAttachment {
    if (file.data !== undefined || file.path === undefined) {
      return file;
    }
    const absolute = isAbsolute(file.path)
      ? file.path
      : this.attachmentRoot === undefined
        ? undefined
        : resolve(this.attachmentRoot, file.path);
    if (absolute === undefined) {
      return file;
    }
    try {
      const bytes = readFileSync(absolute);
      if (bytes.byteLength > ContextAssembler.MAX_HYDRATE_BYTES) {
        return file;
      }
      return { ...file, data: bytes.toString('base64') };
    } catch {
      return file;
    }
  }

  /** 水合单附件的字节上限：与 `view_image` 的 5 MiB 上限同量级，防止异常大文件撑爆内存。 */
  private static readonly MAX_HYDRATE_BYTES = 8 * 1024 * 1024;

  /**
   * 累积工具结果携带的文件附件（P2-⑬）。
   *
   * @param event tool_result 事件。
   * @returns 无返回值。
   */
  private collectAttachments(event: SessionEvent): void {
    const files = this.filesOf(event);
    if (files === undefined || files.length === 0) {
      return;
    }
    this.pendingAttachments.push(...files);
  }

  /**
   * 把累积的工具结果附件 flush 成**一条** user 消息（本工具轮的全部 tool 消息之后）。
   *
   * 调用点有两处：① `append` 遇到下一条非 `tool_result` 事件（本轮结束，紧跟其轮次）；
   * ② `build` 末尾（日志以 tool_result 收尾的会话，兜底 flush）。
   * 见 {@link ContextAssembler.pendingAttachments} 的时机论证。
   *
   * @param messages 已组装的消息序列（原地追加）。
   * @returns 无返回值（无附件时不产生任何消息）。
   */
  private flushPendingAttachments(messages: ModelMessage[]): void {
    if (this.pendingAttachments.length === 0) {
      return;
    }
    const names = this.pendingAttachments.map((file) => file.name).join('、');
    messages.push({
      role: 'user',
      content: `[工具读取的文件附件] ${names}`,
      files: [...this.pendingAttachments],
    });
    this.pendingAttachments = [];
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
