import type {
  ModelMessage,
  ModelOutput,
  ModelPort,
  ModelRequest,
  ModelToolCallRef,
  ModelToolSpec,
  ModelUsage,
  StreamCallbacks,
} from '../../ports/model.js';
import { ModelCallError } from '../../ports/model.js';
import { PromptCacheUsageReader } from './promptCacheUsageReader.js';
import { sseParser } from './sseParser.js';
import { log } from '../../util/logger.js';
import { sanitizeToolRounds } from '../../util/toolRoundSanitizer.js';

/** OpenAI 兼容模型适配器配置。 */
export interface OpenAiCompatibleConfig {
  /** 兼容端点根地址（适配器在其后追加 /chat/completions）。 */
  readonly baseUrl: string;
  /** Bearer 鉴权用的 API 密钥。 */
  readonly apiKey: string;
  /** 模型标识（同时作为端口契约的适配器名）。 */
  readonly model: string;
}

/** 解析 Retry-After（秒数或 HTTP-date），越界或非法返回 undefined（#M6）。
 * @param value Retry-After 响应头原文（纯秒数或 HTTP 日期两种格式）。
 * @returns 折算后的等待毫秒数（上限 60 秒）；格式非法或日期已过期时为 undefined。
 */
function parseRetryAfter(value: string): number | undefined {
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) {
    const secs = Number(trimmed);
    if (Number.isFinite(secs)) {
      return Math.min(60_000, secs * 1000);
    }
  }
  const date = Date.parse(trimmed);
  if (!Number.isNaN(date)) {
    const delta = date - Date.now();
    if (delta > 0) {
      return Math.min(60_000, delta);
    }
  }
  return undefined;
}

/** OpenAI 兼容 chat/completions 客户端（DeepSeek/OpenAI/任意兼容端点）。 */
export class OpenAiCompatibleModel implements ModelPort {
  /** 适配器名（端口契约），取配置的模型标识（config.model）。 */
  public readonly name: string;
  /** 提示缓存命中量读取器（三家字段名不同，读取逻辑集中在 reader，本类只调用）。 */
  private readonly promptCache = new PromptCacheUsageReader();

  public constructor(
    /** 适配器配置：兼容端点地址、API 密钥与模型标识。 */
    private readonly config: OpenAiCompatibleConfig,
  ) {
    this.name = config.model;
  }

  /** 生成响应。
   * @param request 模型请求（消息、工具规格、推理强度与可选取消信号）。
   * @returns 解析后的统一输出（文本、推理、工具调用与用量）；非 2xx 时抛出结构化 ModelCallError。
   */
  public async generate(request: ModelRequest): Promise<ModelOutput> {
    const response = await fetch(this.endpoint(), this.buildRequest(request));
    if (!response.ok) {
      throw await this.httpError(response, '模型请求失败', request);
    }
    const body = (await response.json()) as ChatCompletionResponse;
    return this.parseOutput(body);
  }

  /** 流式生成（SSE）。
   * @param request 模型请求（消息、工具规格、推理强度与可选取消信号）。
   * @param callbacks 流式回调集合：文本增量、工具调用参数增量实时推送。
   * @returns 流结束后的完整输出：文本/推理按增量顺序拼接，工具调用参数按 index 分桶
   *          渐进累积后一次性解析；末块 usage 回填供成本护栏。响应体缺失时降级为非流式 generate；
   *          非 2xx 时抛出结构化 ModelCallError。
   */
  public async stream(request: ModelRequest, callbacks: StreamCallbacks): Promise<ModelOutput> {
    const init = this.buildRequest(request);
    const body = this.bodyOf(request);
    // stream_options.include_usage 让兼容端点（DeepSeek/OpenAI）在末块回传 usage，供成本护栏记账。
    init.body = JSON.stringify({ ...body, stream: true, stream_options: { include_usage: true } });
    const response = await fetch(this.endpoint(), init);
    if (!response.ok) {
      throw await this.httpError(response, '模型流式请求失败', request);
    }
    const streamBody = response.body;
    if (streamBody === null) {
      return this.generate(request);
    }
    // 累积状态：文本块 + 推理块 + 工具调用块（含末块 usage）。工具调用必须与 generate 路径等价地
    // 回填进 ModelOutput，否则走流式（默认 runtime.live 常驻）的 agent 永远收不到 tool_calls，
    // 退化成"只吐文本、不调工具"（#P3 能力评估曾因此全量 steps:1）。
    // 推理块：DeepSeek v4 思考模式流式返回 reasoning_content，必须收集并回传，否则下轮 HTTP 400。
    const state: StreamState = {
      chunks: [],
      reasoningChunks: [],
      toolBlocks: [],
      usage: undefined,
    };
    await sseParser.read(streamBody, (event) =>
      this.handleStreamEvent(event.data, callbacks, state),
    );
    const text = state.chunks.length > 0 ? state.chunks.join('') : undefined;
    const reasoning = state.reasoningChunks.length > 0 ? state.reasoningChunks.join('') : undefined;
    const defined = state.toolBlocks.filter(
      (b): b is { id: string; name?: string; partial: string } =>
        b !== undefined && b.id !== undefined,
    );
    const toolCalls =
      defined.length > 0
        ? defined.map((b) => ({
            id: b.id,
            name: b.name ?? '',
            arguments: this.parseArguments(b.partial),
          }))
        : undefined;
    return { text, reasoning, toolCalls, usage: state.usage };
  }

  /** 构造请求端点。
   * @returns chat/completions 完整 URL（baseUrl 追加标准路径）。
   */
  private endpoint(): string {
    return `${this.config.baseUrl}/chat/completions`;
  }

  /**
   * 把非 2xx 响应转结构化错误（#M6）：429/408/409/5xx 标为可重试，其余 4xx 不可重试；
   * 若响应带 Retry-After 头则解析为毫秒数随错返回，供重试装饰器直接采用。
   * 非 2xx 时把响应 body 也记录到 error 日志，方便定位 400 真实原因。
   * @param response fetch 返回的非 2xx 响应。
   * @param label 错误消息前缀（区分普通生成与流式生成两条路径）。
   * @param request 原始请求；400 时用于 dump messages 关键字段辅助定位。
   * @returns 携带 status / retryable / retryAfterMs 的结构化模型调用错误（不抛出，由调用方决定）。
   */
  private async httpError(
    response: Response,
    label: string,
    request?: ModelRequest,
  ): Promise<ModelCallError> {
    const status = response.status;
    const retryable =
      status === 429 || status === 408 || status === 409 || (status >= 500 && status <= 599);
    const retryAfter = response.headers.get('retry-after');
    const retryAfterMs = retryAfter === null ? undefined : parseRetryAfter(retryAfter);
    const bodyText = await response.text().catch(() => '<unreadable>');
    // #OBS-6：400 时把请求 messages 的 assistant 段落关键字段一并 dump（含 reasoning_content 是否缺失），
    // 方便定位「deepseek 思考模式 must be passed back」类问题的实际断点。
    const dump: Record<string, unknown> = { status, label, body: bodyText.slice(0, 2000) };
    if (request !== undefined && status === 400) {
      const summary = request.messages.map((m, i) => {
        const wire = m as unknown as Record<string, unknown>;
        return {
          i,
          role: wire['role'],
          hasContent:
            typeof wire['content'] === 'string' ? wire['content'].slice(0, 80) : wire['content'],
          hasReasoning:
            typeof wire['reasoningContent'] === 'string'
              ? `len=${(wire['reasoningContent'] as string).length}`
              : 'NO',
          toolCalls: Array.isArray(wire['toolCalls']) ? (wire['toolCalls'] as unknown[]).length : 0,
          toolCallId: wire['toolCallId'],
        };
      });
      dump['reqMessages'] = summary;
    }
    log.error('model.http.error', dump);
    return new ModelCallError(`${label}: HTTP ${status}`, { status, retryable, retryAfterMs });
  }

  /** 构造请求体。
   * @param request 模型请求，决定 body 内容与是否透传取消信号。
   * @returns 可直接交给 fetch 的 RequestInit（POST、鉴权头与 JSON 序列化后的请求体）。
   */
  private buildRequest(request: ModelRequest): RequestInit {
    return {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(this.bodyOf(request)),
      // V2：协作式取消——signal 存在时透传给 fetch，取消即中断在飞请求。
      ...(request.signal !== undefined ? { signal: request.signal } : {}),
    };
  }

  /** 请求头。
   * @returns 含 JSON Content-Type 与 Bearer 鉴权的请求头集合。
   */
  private headers(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.config.apiKey}`,
    };
  }

  /** 请求体。
   * @param request 模型请求（消息先经工具轮次规整，再转 wire 格式）。
   * @returns chat/completions 请求体：model/messages，工具非空时附 tools，
   *          reasoningEffort 非空串时透传 reasoning_effort（空串不发，避免部分端点 400）。
   */
  private bodyOf(request: ModelRequest): Record<string, unknown> {
    // thinking 模式判定：与下文 reasoning_effort 透传同源——非空字符串即视为已开启。
    // 该标记会传给 toWireMessages，用于在历史 assistant 消息 reasoningContent 缺失但带
    // tool_calls 时强制注入 reasoning_content:""，避免 DeepSeek v4 等推理模型下轮 400。
    const thinking = typeof request.reasoningEffort === 'string' && request.reasoningEffort !== '';
    // 消息出栈前统一规整：丢弃 orphan tool、丢弃 tool_calls 响应不全的整段 assistant
    // 回合（#OBS-8 全链路兜底，2026-09-08 二次复现，OpenAI/DeepSeek HTTP 400）。
    const messages = this.toWireMessages(sanitizeToolRounds(request.messages), thinking);
    const body: Record<string, unknown> = {
      model: this.config.model,
      messages,
      ...(request.tools.length > 0 ? { tools: this.toWireTools(request.tools) } : {}),
    };
    // 推理强度透传（#B6）：未设或空串一律不发——DeepSeek 等端点对 reasoning_effort:""
    // 返回 HTTP 400（unknown variant，2026-09-06 实测）。非空时尊重调用方显式意图直接透传：
    // 是否真的支持由端点决定，适配器不做模型名猜测（此前用 reasoner/thinking/r1 正则门禁
    // 会误拦用户显式请求，导致"非空 reasoning_effort 透传"失败）。
    const effort = request.reasoningEffort;
    if (typeof effort === 'string' && effort !== '') {
      body.reasoning_effort = effort;
    }
    return body;
  }

  /** 消息转 wire 格式。
   * @param messages 已规整的消息列表（orphan tool 与残缺 assistant 回合已被丢弃）。
   * @param thinking 思考模式标记（reasoningEffort 非空即视为开启）；为 true 时对带工具调用的
   *                 assistant 消息兜底注入 reasoning_content 空串占位，避免推理模型下轮 400。
   * @returns OpenAI wire 消息数组（tool_calls 序列化、tool_call_id 回填、reasoning_content 一致性维护）。
   */
  private toWireMessages(
    messages: readonly ModelRequest['messages'][number][],
    thinking: boolean,
  ): unknown[] {
    return messages.map((message) => {
      const wire: Record<string, unknown> = { role: message.role };
      const toolCalls = message.role === 'assistant' ? message.toolCalls : undefined;
      if (toolCalls !== undefined && toolCalls.length > 0) {
        // assistant 带 tool_calls：OpenAI 要求 arguments 为 JSON 字符串、type 固定 function。
        wire.tool_calls = toolCalls.map((call) => ({
          id: call.id,
          type: 'function',
          function: { name: call.name, arguments: JSON.stringify(call.arguments ?? {}) },
        }));
        // 带 tool_calls 的 assistant 消息 content 字段必须存在（空串时置 null）。
        wire.content = message.content === '' ? null : message.content;
      } else {
        wire.content = this.contentOf(message);
      }
      if (message.role === 'tool' && message.toolCallId !== undefined) {
        wire.tool_call_id = message.toolCallId;
      }
      // 思考模式回传：DeepSeek v4 等推理模型硬性要求把上一轮 assistant 的 reasoning_content
      // 原样回传，缺失即 HTTP 400（"must be passed back"，2026-09-06 实测铁证）。
      // 字段已定义时（含空串占位）一律输出：上下文组装器会在思考模式激活后给缺推理的
      // assistant 补空串，维持 reasoning_content 在对话历史中的一致性（空串已验证 200）。
      // 非思考对话（reasoningContent 为 undefined）则不注入该字段，保持 OpenAI 端点兼容。
      if (message.role === 'assistant' && message.reasoningContent !== undefined) {
        wire.reasoning_content = message.reasoningContent;
      } else if (
        thinking &&
        message.role === 'assistant' &&
        message.toolCalls !== undefined &&
        message.toolCalls.length > 0
      ) {
        // 兜底（#OBS-7，2026-09-07 实测）：思考模式 + assistant 带 tool_calls 时即使历史里
        // reasoningContent===undefined（流式未返回 reasoning 段、或消息生成于启用思考前），
        // 也必须注入 reasoning_content:"" 占位——否则 DeepSeek v4 下轮 HTTP 400。
        // 上一行是「字段已定义」的常规路径；这一行是「字段未定义但 thinking 已开且带工具」
        // 的兜底路径，两者互斥，覆盖 reasoningContent 全 3 个分支。
        wire.reasoning_content = '';
      }
      return wire;
    });
  }

  /**
   * 消息 content 转换：含图像时构造为 `[text, ...image_url]` 数组（#B1），
   * 文件附件按类型追加为图像或文本说明（#B5）；纯文本退化为字符串（向后兼容）。
   * @param message 统一消息（可能携带图像、文件附件）。
   * @returns 纯文本时返回字符串；含视觉输入时返回 `[text, ...image_url, ...附件说明]` 分段数组。
   */
  private contentOf(message: ModelMessage): unknown {
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
    const parts: unknown[] = [{ type: 'text', text: message.content }];
    for (const image of images ?? []) {
      parts.push({
        type: 'image_url',
        image_url: { url: image.url ?? `data:${image.mediaType};base64,${image.data}` },
      });
    }
    for (const file of imageFiles) {
      parts.push({
        type: 'image_url',
        image_url: { url: file.url ?? `data:${file.mediaType};base64,${file.data}` },
      });
    }
    // 非图片文件无法作为视觉输入，注入文件名 + MIME 的文本说明保上下文完整。
    for (const file of textFiles) {
      parts.push({ type: 'text', text: `[附件] ${file.name}（${file.mediaType}）` });
    }
    return parts;
  }

  /** 工具转 wire 格式。
   * @param tools 统一工具规格列表。
   * @returns OpenAI tools 数组，每项为 type=function 且参数嵌套在 function 字段内的声明。
   */
  private toWireTools(tools: readonly ModelToolSpec[]): unknown[] {
    return tools.map((tool) => ({
      type: 'function',
      function: { name: tool.name, description: tool.description, parameters: tool.parameters },
    }));
  }

  /** 解析响应为统一输出。
   * @param body wire 层 JSON 响应。
   * @returns 统一模型输出（取首个 choice 的消息内容；含提示缓存命中量）；无 choice 时返回空对象。
   */
  private parseOutput(body: ChatCompletionResponse): ModelOutput {
    const choice = body.choices[0];
    if (choice === undefined) {
      return {};
    }
    const message = choice.message;
    const output: {
      reasoning?: string;
      text?: string;
      toolCalls?: readonly ModelToolCallRef[];
      usage?: ModelUsage;
    } = {};
    if (message.reasoning_content !== undefined && message.reasoning_content !== '') {
      output.reasoning = message.reasoning_content;
    }
    if (message.content !== undefined && message.content !== null && message.content !== '') {
      output.text = message.content;
    }
    if (message.tool_calls !== undefined && message.tool_calls.length > 0) {
      output.toolCalls = message.tool_calls.map((call) => this.parseToolCall(call));
    }
    // #S29 用量：OpenAI 兼容端点返回 usage.prompt_tokens / completion_tokens / total_tokens。
    // 另取提示缓存命中量（OpenAI `prompt_tokens_details.cached_tokens` 或 DeepSeek
    // `prompt_cache_hit_tokens`）——缺字段时为 undefined，读者侧据此区分「未知」与「0 命中」。
    if (body.usage !== undefined) {
      output.usage = {
        promptTokens: body.usage.prompt_tokens,
        completionTokens: body.usage.completion_tokens,
        totalTokens: body.usage.total_tokens,
        cachedPromptTokens: this.promptCache.readOpenAiCompatible(body.usage),
      };
    }
    return output;
  }

  /** 解析单个工具调用。
   * @param call wire 层工具调用（参数为 JSON 字符串）。
   * @returns 统一工具调用引用（id/name/已解析参数对象）。
   */
  private parseToolCall(call: WireToolCall): ModelToolCallRef {
    return {
      id: call.id,
      name: call.function.name,
      arguments: this.parseArguments(call.function.arguments),
    };
  }

  /** 解析工具参数 JSON。
   * @param raw wire 层返回的参数 JSON 字符串。
   * @returns 解析出的参数对象；JSON 非法或不是对象时返回空对象（不抛错，保证流不中断）。
   */
  private parseArguments(raw: string): Record<string, unknown> {
    try {
      const parsed: unknown = JSON.parse(raw);
      return typeof parsed === 'object' && parsed !== null
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }

  /** 处理流式事件。
   * @param data SSE 已分帧的事件 data 负载（JSON 文本；[DONE] 终止标记直接忽略）。
   * @param callbacks 流式回调集合：文本增量经 onText、工具参数增量经 onToolInput 推出。
   * @param state 跨事件共享的累积状态：文本块、推理块、按 index 分桶的工具调用块与末块 usage。
   */
  private handleStreamEvent(data: string, callbacks: StreamCallbacks, state: StreamState): void {
    if (data === '[DONE]') {
      return;
    }
    const json = JSON.parse(data) as ChatCompletionChunk & {
      readonly usage?: {
        readonly prompt_tokens: number;
        readonly completion_tokens: number;
        readonly total_tokens: number;
        readonly prompt_tokens_details?: { readonly cached_tokens?: number };
        readonly prompt_cache_hit_tokens?: number;
      };
    };
    // 末块（choices 为空）常带 usage，回填供成本护栏记账（与 generate 路径一致）。
    // 注意：中间块常回传 usage:null，必须用 != null 同时排除 null/undefined。
    if (json.usage != null) {
      state.usage = {
        promptTokens: json.usage.prompt_tokens,
        completionTokens: json.usage.completion_tokens,
        totalTokens: json.usage.total_tokens,
        cachedPromptTokens: this.promptCache.readOpenAiCompatible(json.usage),
      };
    }
    const delta = json.choices[0]?.delta;
    // #B3 工具调用参数渐进增量（OpenAI 把参数拆成多个 arguments 片段推送）。
    if (delta?.tool_calls !== undefined) {
      for (const tc of delta.tool_calls) {
        const idx = tc.index ?? 0;
        let block = state.toolBlocks[idx];
        if (block === undefined) {
          block = { id: tc.id, name: tc.function?.name, partial: '' };
          state.toolBlocks[idx] = block;
        }
        if (tc.id !== undefined) block.id = tc.id;
        if (tc.function?.name !== undefined) block.name = tc.function.name;
        if (tc.function?.arguments !== undefined) block.partial += tc.function.arguments;
        callbacks.onToolInput?.({ id: block.id, name: block.name, partialJson: block.partial });
      }
      return;
    }
    if (delta?.content !== undefined && delta.content !== null && delta.content !== '') {
      callbacks.onText(delta.content);
      state.chunks.push(delta.content);
    }
    // 思考模式：收集 reasoning_content 增量，下轮回传用（DeepSeek 硬性要求）。
    if (
      delta?.reasoning_content !== undefined &&
      delta.reasoning_content !== null &&
      delta.reasoning_content !== ''
    ) {
      state.reasoningChunks.push(delta.reasoning_content);
    }
  }
}

/** 流式累积状态：文本块 + 推理块 + 工具调用块（按 index 分桶）+ 末块 usage。 */
interface StreamState {
  chunks: string[];
  reasoningChunks: string[];
  toolBlocks: ({ id?: string; name?: string; partial: string } | undefined)[];
  usage: ModelUsage | undefined;
}

/** 流式块类型。 */
interface ChatCompletionChunk {
  readonly choices: readonly {
    readonly delta?: {
      content?: string | null;
      reasoning_content?: string | null;
      tool_calls?: readonly {
        index?: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }[];
    };
  }[];
}

/** wire 层响应类型。 */
interface ChatCompletionResponse {
  readonly choices: readonly {
    readonly message: {
      readonly role: string;
      readonly content?: string | null;
      readonly reasoning_content?: string;
      readonly tool_calls?: readonly WireToolCall[];
    };
  }[];
  /** token 用量（#S29）。 */
  readonly usage?: {
    readonly prompt_tokens: number;
    readonly completion_tokens: number;
    readonly total_tokens: number;
    /** OpenAI 系缓存明细（命中量在 cached_tokens）。 */
    readonly prompt_tokens_details?: { readonly cached_tokens?: number };
    /** DeepSeek 系缓存命中量（与 OpenAI 明细二选一，视端点而定）。 */
    readonly prompt_cache_hit_tokens?: number;
  };
}

/** wire 层工具调用类型。 */
interface WireToolCall {
  readonly id: string;
  readonly function: {
    readonly name: string;
    readonly arguments: string;
  };
}
