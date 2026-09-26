import type {
  ImageContent,
  FileAttachment,
  ModelMessage,
  ModelOutput,
  ModelPort,
  ModelRequest,
  ModelToolCallRef,
  ModelToolSpec,
  ModelUsage,
  StreamCallbacks,
} from '../../ports/model/model.js';
import {
  AnthropicCacheBreakpoints,
  type AnthropicWireBlock,
  type AnthropicWireMessage,
} from './anthropicCacheBreakpoints.js';
import { PromptCacheUsageReader } from './promptCacheUsageReader.js';
import { sseParser } from './sseParser.js';

/** Anthropic 模型配置。 */
export interface AnthropicModelConfig {
  /** API 基址（适配器在其后追加 /v1/messages）。 */
  readonly baseUrl: string;
  /** x-api-key 鉴权头使用的密钥。 */
  readonly apiKey: string;
  /** 模型标识（同时作为端口契约的适配器名）。 */
  readonly model: string;
  /** 单次响应的最大输出 token 数（缺省 4096）。 */
  readonly maxTokens?: number;
}

/** Anthropic Messages API 适配器（真实第二协议）。 */
export class AnthropicModel implements ModelPort {
  /** 适配器名（端口契约），取配置的模型标识（config.model）。 */
  public readonly name: string;
  /** 提示缓存读取器：Anthropic 用 `cache_read_input_tokens` 表达命中。 */
  private readonly promptCache = new PromptCacheUsageReader();
  /** 滚动缓存断点规划器：system + 最近若干轮 user 消息共 ≤4 个断点（纯函数）。 */
  private readonly cacheBreakpoints = new AnthropicCacheBreakpoints();

  public constructor(
    /** 适配器配置：端点、密钥、模型标识与输出上限。 */
    private readonly config: AnthropicModelConfig,
  ) {
    this.name = config.model;
  }

  /** 生成响应。
   * @param request 模型请求（消息、工具规格与可选取消信号）。
   * @returns 解析后的统一输出（文本、工具调用与口径合成后的用量）；非 2xx 时抛出错误。
   */
  public async generate(request: ModelRequest): Promise<ModelOutput> {
    const response = await fetch(this.endpoint(), this.buildRequest(request));
    if (!response.ok) {
      throw new Error(`Anthropic 请求失败: HTTP ${response.status}`);
    }
    const body = (await response.json()) as AnthropicResponse;
    return this.parseOutput(body);
  }

  /** 流式生成（SSE）。
   * @param request 模型请求（消息、工具规格与可选取消信号）。
   * @param callbacks 流式回调集合：文本增量与工具参数增量实时推送。
   * @returns 流结束后的完整输出：文本按增量顺序拼接；用量由 message_start/message_delta
   *          两类事件离线累积后合成。响应体缺失时降级为非流式 generate；非 2xx 时抛出错误。
   */
  public async stream(request: ModelRequest, callbacks: StreamCallbacks): Promise<ModelOutput> {
    const response = await fetch(this.endpoint(), this.buildRequest(request));
    if (!response.ok) {
      throw new Error(`Anthropic 流式请求失败: HTTP ${response.status}`);
    }
    const body = response.body;
    if (body === null) {
      return this.generate(request);
    }
    const chunks: string[] = [];
    const toolBlocks: {
      index: number;
      id?: string | undefined;
      name?: string | undefined;
      partial: string;
    }[] = [];
    // 流式用量累积：message_start 给 input/cache 三段，message_delta 给 output，
    // 与 generate 路径同口径合成 ModelUsage（此前流式路径完全丢弃用量，成本护栏看不到 Anthropic 消耗）。
    const usageState: AnthropicUsageState = {};
    await sseParser.read(body, (event) =>
      this.handleEvent(event.data, callbacks, chunks, toolBlocks, usageState),
    );
    const usage = this.usageOf(usageState);
    if (usage === undefined) {
      return { text: chunks.join('') };
    }
    return { text: chunks.join(''), usage };
  }

  /** 构造端点。
   * @returns Messages API 完整 URL（baseUrl 追加 /v1/messages）。
   */
  private endpoint(): string {
    return `${this.config.baseUrl}/v1/messages`;
  }

  /**
   * 构造请求。
   * @param request 模型请求（system 被剥离为独立字段并打 ephemeral 缓存断点）。
   * @returns 可直接交给 fetch 的 RequestInit（POST、协议头、JSON 请求体与可选取消信号）。
   */
  private buildRequest(request: ModelRequest): RequestInit {
    const { system, messages } = this.splitSystem(request.messages);
    return {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(this.wireBody(system, messages, request.tools)),
      // V2：协作式取消——signal 存在时透传给 fetch，取消即中断在飞请求。
      ...(request.signal !== undefined ? { signal: request.signal } : {}),
    };
  }

  /**
   * 组装请求体：system 独立成 text block，消息侧按**滚动窗口**打缓存断点。
   *
   * 前缀稳定性：断点只**追加/前移**，不重排消息顺序、不插入动态内容，
   * 因此第 N 轮发出的前缀在第 N+1 轮仍是逐字节前缀（`prefix-stability.mjs` 度量的不变量）。
   *
   * @param system 剥离出的 system 文本（undefined 表示无 system 段）。
   * @param messages 已剥离 system 的 wire 消息（tool 角色已映射为 user）。
   * @param tools 统一工具规格列表（转 Anthropic tools 结构）。
   * @returns 可直接 JSON.stringify 的请求体对象。
   */
  private wireBody(
    system: string | undefined,
    messages: readonly AnthropicWireMessage[],
    tools: readonly ModelToolSpec[],
  ): Record<string, unknown> {
    const plan = this.cacheBreakpoints.plan(messages, system !== undefined);
    return {
      model: this.config.model,
      max_tokens: this.config.maxTokens ?? 4096,
      // V2.1（C10 prompt caching）：system 作为独立 text block 并打上 ephemeral
      // 缓存断点——system 前缀跨回合稳定（不变内容 + 追加），命中缓存可省重复
      // 计费 token。Anthropic 专属字段；system 缺省时保持原行为（不带该字段）。
      ...(system !== undefined
        ? {
            system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
          }
        : {}),
      messages: plan.messages,
      tools: this.toTools(tools),
    };
  }

  /** 请求头。
   * @returns 含 content-type、x-api-key 鉴权与 anthropic-version 协议版本的头集合。
   */
  private headers(): Record<string, string> {
    return {
      'content-type': 'application/json',
      'x-api-key': this.config.apiKey,
      'anthropic-version': '2023-06-01',
    };
  }

  /**
   * 拆分 system 消息（Anthropic 用独立字段，且 `messages` 里**没有** system 角色）。
   *
   * **只有开头连续的 system 消息**才提升进顶层 `system` 字段；出现在事件历史**之后**的
   * system 消息（典型：每步随查询变化的 repo-map 尾段、运行期提示）**留在原位**并降级为
   * `user` 消息。理由是一条物理事实：Anthropic 的提示缓存只复用**字节级公共前缀**，而顶层
   * `system` 排在**所有消息之前**——一旦把逐步变化的尾段提升上去，其后整段事件历史（提示里
   * 的大头）每一步都会重新计费。`StepContextBuilder` 已按「固定头 → 事件历史 → 动态尾段」
   * 排布（P_prefix 治理），若这里把尾段搬回最前，等于在 wire 层把该治理**静默撤销**。
   *
   * 现场度量（同一 fixture，`tests/unit/anthropicWirePrefix.test.ts`）：提升时整请求前缀复用率
   * **~17%**；留在原位后 **≥ 90%**。零信息损失（内容逐字节不变，只换承载角色与位置）。
   *
   * @param messages 统一消息列表。
   * @returns system 文本（开头无 system 消息时为 undefined）与剥离后的 wire 消息数组
   *          （tool 角色映射为 user 以兼容 Anthropic 协议；非开头的 system 同样降级为 user）。
   */
  private splitSystem(messages: readonly ModelMessage[]): {
    system?: string | undefined;
    messages: AnthropicWireMessage[];
  } {
    let head = 0;
    while (head < messages.length && messages[head]?.role === 'system') {
      head += 1;
    }
    const system = messages
      .slice(0, head)
      .map((message) => message.content)
      .join('\n');
    const rest = messages.slice(head).map((message) => ({
      // assistant 保持原角色；user / tool / 非开头 system 一律映射为 user。
      role: message.role === 'assistant' ? 'assistant' : 'user',
      content: this.toWireContent(message),
    }));
    return { system: system === '' ? undefined : system, messages: rest };
  }

  /**
   * 构造单条消息的 content：无图像时保持原字符串（向后兼容）；
   * 含图像时构造为 [text, ...image] 数组（#B1）。
   * @param message 统一消息（可能携带图像与文件附件）。
   * @returns 纯文本时返回字符串；含视觉输入时返回 [text, ...image, ...附件说明] 分段数组，
   *          图像以 url 或 base64 source 表达，非图片文件降级为文本说明。
   */
  private toWireContent(message: ModelMessage): string | AnthropicWireBlock[] {
    const images = message.images;
    const imageFiles = (message.files ?? []).filter((f) => f.mediaType.startsWith('image/'));
    const textFiles = (message.files ?? []).filter((f) => !f.mediaType.startsWith('image/'));
    if (
      (images === undefined || images.length === 0) &&
      imageFiles.length === 0 &&
      textFiles.length === 0
    ) {
      return message.content;
    }
    return [
      { type: 'text', text: message.content },
      ...(images ?? []).map((image: ImageContent) => ({
        type: 'image',
        source:
          image.url !== undefined
            ? { type: 'url', url: image.url }
            : { type: 'base64', media_type: image.mediaType, data: image.data },
      })),
      ...imageFiles.map((f: FileAttachment) => ({
        type: 'image',
        source:
          f.url !== undefined
            ? { type: 'url', url: f.url }
            : { type: 'base64', media_type: f.mediaType, data: f.data },
      })),
      ...textFiles.map((f: FileAttachment) => ({
        type: 'text',
        text: `[附件] ${f.name} (${f.mediaType})`,
      })),
    ];
  }

  /** 工具转 Anthropic 格式。
   * @param tools 统一工具规格列表。
   * @returns Anthropic tools 数组（name/description/input_schema 平铺结构）。
   */
  private toTools(tools: readonly ModelToolSpec[]): unknown[] {
    return tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.parameters,
    }));
  }

  /** 解析响应。
   * @param body wire 层 JSON 响应。
   * @returns 统一模型输出：text 块拼接、tool_use 块转工具调用引用、usage 按缓存口径合成；
   *          各段为空/缺失时对应字段不出现在输出中。
   */
  private parseOutput(body: AnthropicResponse): ModelOutput {
    const text = body.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('');
    const toolCalls = body.content
      .filter((block): block is ToolUseBlock => block.type === 'tool_use')
      .map((block) => ({
        id: block.id,
        name: block.name,
        arguments: block.input as Record<string, unknown>,
      }));
    const usage = this.usageOf(body.usage);
    const output: {
      text?: string;
      toolCalls?: readonly ModelToolCallRef[];
      usage?: ModelUsage;
    } = {};
    if (text !== '') {
      output.text = text;
    }
    if (toolCalls.length > 0) {
      output.toolCalls = toolCalls;
    }
    if (usage !== undefined) {
      output.usage = usage;
    }
    return output;
  }

  /**
   * 由原始 usage 合成统一用量。
   *
   * 口径说明（对齐 OpenAI 兼容端点的 `prompt_tokens` 语义）：Anthropic 的 `input_tokens`
   * **不含**缓存读取与缓存写入部分，故 promptTokens = input + cache_creation + cache_read，
   * 否则跨厂商比较「输入规模」时 Anthropic 会系统性偏低。命中量单列 cachedPromptTokens，
   * 使 `cached / prompt` 的缓存命中率在三个厂商间可比。
   *
   * @param raw 原始 usage（流式为离线累积的 State，非流式为响应体 usage）
   * @returns 统一用量；三段 input 全缺时为 undefined（不臆造 0）
   */
  private usageOf(
    raw: AnthropicUsageState | AnthropicUsageWire | undefined,
  ): ModelUsage | undefined {
    if (raw === undefined) return undefined;
    const input = typeof raw.input_tokens === 'number' ? raw.input_tokens : undefined;
    const cacheCreate =
      typeof raw.cache_creation_input_tokens === 'number' ? raw.cache_creation_input_tokens : 0;
    const cached = this.promptCache.readAnthropic(raw);
    if (input === undefined && cached === undefined && cacheCreate === 0) return undefined;
    const promptTokens = (input ?? 0) + cacheCreate + (cached ?? 0);
    const completionTokens = typeof raw.output_tokens === 'number' ? raw.output_tokens : 0;
    return cached === undefined
      ? { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens }
      : {
          promptTokens,
          completionTokens,
          totalTokens: promptTokens + completionTokens,
          cachedPromptTokens: cached,
        };
  }

  /** 处理流式事件。
   * @param data SSE 已分帧的事件 data 负载（JSON 文本；[DONE] 直接忽略）。
   * @param callbacks 流式回调集合：text_delta 经 onText、工具块开始/参数增量经 onToolInput 推出。
   * @param chunks 跨事件累积的文本增量（就地追加）。
   * @param toolBlocks 跨事件累积的工具调用块（按流中顺序入栈，就地更新 partial）。
   * @param usageState 跨事件累积的用量状态（经 observeUsage 原地覆盖写）。
   
 * @returns 无返回值。
*/
  private handleEvent(
    data: string,
    callbacks: StreamCallbacks,
    chunks: string[],
    toolBlocks: {
      index: number;
      id?: string | undefined;
      name?: string | undefined;
      partial: string;
    }[],
    usageState: AnthropicUsageState,
  ): void {
    if (data === '[DONE]') {
      return;
    }
    const json = JSON.parse(data) as AnthropicStreamEvent;
    this.observeUsage(json, usageState);
    // #B3 工具调用开始：记录 id/name，先推一次空增量（便于 UI 立即显示「调用中」）。
    if (json.type === 'content_block_start' && json.content_block?.type === 'tool_use') {
      const index = json.index ?? toolBlocks.length;
      toolBlocks.push({
        index,
        id: json.content_block.id,
        name: json.content_block.name,
        partial: '',
      });
      callbacks.onToolInput?.({
        id: json.content_block.id,
        name: json.content_block.name,
        partialJson: '',
      });
      return;
    }
    // #B3 工具参数渐进增量（Anthropic 的 content_block.index 未必从 0 连续，
    // 工具块在流中顺序出现，故取最后入栈的块即可正确累积）。
    if (json.type === 'content_block_delta' && json.delta?.type === 'input_json_delta') {
      const block = toolBlocks[toolBlocks.length - 1];
      if (block !== undefined) {
        block.partial += json.delta.partial_json ?? '';
        callbacks.onToolInput?.({ id: block.id, name: block.name, partialJson: block.partial });
      }
      return;
    }
    if (json.type === 'content_block_delta' && json.delta?.type === 'text_delta') {
      const text = json.delta?.text ?? '';
      callbacks.onText(text);
      chunks.push(text);
    }
  }

  /**
   * 从流式事件累积用量：`message_start`（input / cache 两段）与 `message_delta`（output，增量覆盖）。
   * 只做**覆盖写**不做累加——Anthropic 的 output_tokens 是累计值，累加会翻倍。
   * @param event 单个流式事件（最小子集类型）
   * @param state 跨事件累积的用量状态（原地更新）
   
 * @returns 无返回值。
*/
  private observeUsage(event: AnthropicStreamEvent, state: AnthropicUsageState): void {
    const start = event.message?.usage;
    if (start !== undefined) {
      state.input_tokens = start.input_tokens ?? state.input_tokens;
      state.cache_creation_input_tokens =
        start.cache_creation_input_tokens ?? state.cache_creation_input_tokens;
      state.cache_read_input_tokens =
        start.cache_read_input_tokens ?? state.cache_read_input_tokens;
    }
    const delta = event.usage;
    if (delta !== undefined) {
      state.output_tokens = delta.output_tokens ?? state.output_tokens;
      state.input_tokens = delta.input_tokens ?? state.input_tokens;
    }
  }
}

/** 流式用量累积状态（字段与 wire 同形，便于直接复用 usageOf 的窄化逻辑）。 */
interface AnthropicUsageState {
  input_tokens?: number | undefined;
  output_tokens?: number | undefined;
  cache_creation_input_tokens?: number | undefined;
  cache_read_input_tokens?: number | undefined;
}

/** wire 层 usage（非流式响应体与流式 message_start 同形）。 */
interface AnthropicUsageWire {
  readonly input_tokens?: number | undefined;
  readonly output_tokens?: number | undefined;
  readonly cache_creation_input_tokens?: number | undefined;
  readonly cache_read_input_tokens?: number | undefined;
}

/** Anthropic 响应类型。 */
interface AnthropicResponse {
  readonly content: readonly (TextBlock | ToolUseBlock)[];
  /** token 用量（#S29；`input_tokens` 不含缓存两段，见 usageOf 的口径说明）。 */
  readonly usage?: AnthropicUsageWire;
}

/** 文本块。 */
interface TextBlock {
  readonly type: 'text';
  readonly text: string;
}

/** 工具使用块。 */
interface ToolUseBlock {
  readonly type: 'tool_use';
  readonly id: string;
  readonly name: string;
  readonly input: unknown;
}

/** 流式事件（最小子集）。 */
interface AnthropicStreamEvent {
  readonly type: string;
  readonly index?: number;
  readonly delta?: { type: string; text?: string; partial_json?: string };
  readonly content_block?: { type: string; id?: string; name?: string; input?: unknown };
  /** `message_start` 携带首段用量（含缓存两段）。 */
  readonly message?: { readonly usage?: AnthropicUsageWire };
  /** `message_delta` 携带 output 累计量。 */
  readonly usage?: AnthropicUsageWire;
}
