import type {
  ModelOutput,
  ModelPort,
  ModelRequest,
  ModelToolCallRef,
  ModelToolSpec,
  ModelUsage,
  StreamCallbacks,
} from '../../ports/model/model.js';
import { PromptCacheUsageReader } from './promptCacheUsageReader.js';
import { sseParser, type SseEvent } from './sseParser.js';

/**
 * @beta
 * Responses API 适配器配置。
 */
export interface ResponsesConfig {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
  /** 起始续接 ID（服务端上下文锚点，缺省开新会话）。 */
  readonly previousResponseId?: string;
  /** 是否让服务端保存上下文（续接前提，默认 true）。 */
  readonly store?: boolean;
}

/** 流式累积状态。 */
interface StreamState {
  readonly text: string[];
  completed: ResponsesResponse | undefined;
}

/**
 * @beta
 * OpenAI Responses API 原生适配器：instructions 独立字段 + 扁平工具 + previous_response_id 服务端续接。
 */
export class ResponsesModel implements ModelPort {
  /** 适配器名（端口契约），取配置的模型标识（config.model）。 */
  public readonly name: string;
  /** 最近一次响应返回的续接 ID（服务端会话锚点；尚未收到任何响应时为 undefined）。 */
  private lastResponseId: string | undefined;
  /** 提示缓存读取器：Responses 用 `input_tokens_details.cached_tokens` 表达命中。 */
  private readonly promptCache = new PromptCacheUsageReader();

  public constructor(
    /** 适配器配置：端点地址、API 密钥、模型标识与续接/存储选项。 */
    private readonly config: ResponsesConfig,
  ) {
    this.name = config.model;
    this.lastResponseId = config.previousResponseId;
  }

  /** 当前续接 ID（下一轮请求带上，由服务端持有历史上下文）。
   * @returns 当前保存的续接 ID；尚未产生任何响应且配置未指定 previousResponseId 时为 undefined。
   */
  public responseId(): string | undefined {
    return this.lastResponseId;
  }

  /** 重置续接锚点（开新会话；服务端上下文不复用）。
   * @returns 无返回值。
   */
  public reset(): void {
    this.lastResponseId = ResponsesModel.configPrevious(this.config);
  }

  /** 生成响应。
   * @param request 模型请求（消息列表、工具规格与可选取消信号）。
   * @returns 解析后的统一输出（文本、推理摘要、工具调用与用量）；HTTP 非 2xx 时抛出错误。
   */
  public async generate(request: ModelRequest): Promise<ModelOutput> {
    const response = await fetch(this.endpoint(), this.buildRequest(request, false));
    if (!response.ok) {
      throw new Error(`模型请求失败: HTTP ${response.status}`);
    }
    const body = (await response.json()) as ResponsesResponse;
    return this.parseOutput(body);
  }

  /** 流式生成（SSE：文本增量实时回调，终态以 response.completed 为准）。
   * @param request 模型请求（消息列表、工具规格与可选取消信号）。
   * @param callbacks 流式回调集合：文本增量经 onText 实时推送。
   * @returns 流结束后的完整输出：优先取 response.completed 终态事件的解析结果，
   *          若流中断未收到终态则退回已累积文本拼接；响应体缺失时降级为非流式 generate。
   */
  public async stream(request: ModelRequest, callbacks: StreamCallbacks): Promise<ModelOutput> {
    const response = await fetch(this.endpoint(), this.buildRequest(request, true));
    if (!response.ok) {
      throw new Error(`模型流式请求失败: HTTP ${response.status}`);
    }
    const streamBody = response.body;
    if (streamBody === null) {
      return this.generate(request);
    }
    const state: StreamState = { text: [], completed: undefined };
    await sseParser.read(streamBody, (event) => this.handleStreamEvent(event, callbacks, state));
    return state.completed === undefined
      ? { text: state.text.join('') }
      : this.parseOutput(state.completed);
  }

  /** 构造请求端点。
   * @returns Responses API 完整 URL（baseUrl 追加 /responses 路径）。
   */
  private endpoint(): string {
    return `${this.config.baseUrl}/responses`;
  }

  /** 构造请求体（stream 时不带 previous_response_id 亦可，此处统一带上以支持续接）。
   * @param request 模型请求，决定 body 内容与是否透传取消信号。
   * @param stream true 表示请求 SSE 流式响应，false 表示一次性 JSON 响应。
   * @returns 可直接交给 fetch 的 RequestInit（POST 方法、鉴权头与 JSON 序列化后的请求体）。
   */
  private buildRequest(request: ModelRequest, stream: boolean): RequestInit {
    return {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ ...this.bodyOf(request), stream }),
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
   * @param request 模型请求，提供消息与工具规格。
   * @returns Responses API 请求体：model/input/tools/store，外加 instructions（非空时）
   *          与 previous_response_id（已有续接锚点时）。
   */
  private bodyOf(request: ModelRequest): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: this.config.model,
      input: this.toWireInput(request.messages),
      tools: this.toWireTools(request.tools),
      store: this.config.store ?? true,
    };
    const instructions = this.instructionsOf(request.messages);
    if (instructions !== '') {
      body['instructions'] = instructions;
    }
    if (this.lastResponseId !== undefined) {
      body['previous_response_id'] = this.lastResponseId;
    }
    return body;
  }

  /** 提取 system 指令（Responses API 用独立 instructions 字段）。
   * @param messages 完整消息列表，仅筛选 role 为 system 的条目。
   * @returns 所有 system 消息按原顺序以空行拼接的文本；无 system 消息时为空串。
   */
  private instructionsOf(messages: readonly ModelRequest['messages'][number][]): string {
    return messages
      .filter((message) => message.role === 'system')
      .map((message) => message.content)
      .join('\n\n');
  }

  /** 消息转 wire 输入（system 已剥离到 instructions）。
   * @param messages 完整消息列表，过滤掉 system 角色后逐条转换。
   * @returns Responses API input 数组，每项形如 { role, content }。
   */
  private toWireInput(messages: readonly ModelRequest['messages'][number][]): unknown[] {
    return messages
      .filter((message) => message.role !== 'system')
      .map((message) => ({ role: message.role, content: message.content }));
  }

  /** 工具转 wire 格式（Responses 为扁平结构，无 function 嵌套）。
   * @param tools 统一工具规格列表。
   * @returns Responses API tools 数组，每项为 type=function 的扁平声明。
   */
  private toWireTools(tools: readonly ModelToolSpec[]): unknown[] {
    return tools.map((tool) => ({
      type: 'function',
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    }));
  }

  /** 解析响应为统一输出，并记录续接锚点。
   * @param body wire 层 JSON 响应。
   * @returns 统一模型输出；副作用：以 body.id 更新 lastResponseId 供下轮续接。
   */
  private parseOutput(body: ResponsesResponse): ModelOutput {
    this.lastResponseId = body.id;
    const items = body.output ?? [];
    const output: {
      reasoning?: string;
      text?: string;
      toolCalls?: readonly ModelToolCallRef[];
      usage?: ModelUsage;
    } = {};
    const reasoning = this.collectReasoning(items);
    if (reasoning !== '') {
      output.reasoning = reasoning;
    }
    const text = this.collectText(items);
    if (text !== '') {
      output.text = text;
    }
    const toolCalls = this.collectToolCalls(items);
    if (toolCalls.length > 0) {
      output.toolCalls = toolCalls;
    }
    // #S29 用量：Responses API 返回 usage.input_tokens / output_tokens / total_tokens。
    // 另取提示缓存命中量 `input_tokens_details.cached_tokens`（缺字段为 undefined，与 0 命中区分）。
    if (body.usage !== undefined) {
      output.usage = {
        promptTokens: body.usage.input_tokens,
        completionTokens: body.usage.output_tokens,
        totalTokens: body.usage.total_tokens,
        cachedPromptTokens: this.promptCache.readResponses(body.usage),
      };
    }
    return output;
  }

  /** 收集 reasoning 摘要文本。
   * @param items wire 层输出项列表。
   * @returns 所有 reasoning 项 summary 文本按序以换行拼接；无 reasoning 项时为空串。
   */
  private collectReasoning(items: readonly ResponsesOutputItem[]): string {
    return items
      .filter((item) => item.type === 'reasoning')
      .flatMap((item) => item.summary ?? [])
      .map((entry) => entry.text)
      .join('\n');
  }

  /** 收集输出文本。
   * @param items wire 层输出项列表。
   * @returns 所有 message 项 content 文本按序直接拼接；无 message 项时为空串。
   */
  private collectText(items: readonly ResponsesOutputItem[]): string {
    return items
      .filter((item) => item.type === 'message')
      .flatMap((item) => item.content ?? [])
      .map((entry) => entry.text)
      .join('');
  }

  /** 收集函数调用。
   * @param items wire 层输出项列表。
   * @returns 所有 function_call 项转成的统一工具调用引用（id/name/已解析参数对象）；
   *          无函数调用时为空数组。
   */
  private collectToolCalls(items: readonly ResponsesOutputItem[]): readonly ModelToolCallRef[] {
    return items
      .filter((item) => item.type === 'function_call' && item.name !== undefined)
      .map((item) => ({
        id: item.call_id ?? '',
        name: item.name ?? '',
        arguments: this.parseArguments(item.arguments),
      }));
  }

  /** 处理流式事件。
   * @param event SSE 已分帧的事件（event 名与 data 负载）。
   * @param callbacks 流式回调集合，文本增量经 onText 推出。
   * @param state 跨事件共享的累积状态：text 收集增量，completed 暂存终态响应。
   *              [DONE] 标记与无法解析的 JSON 直接忽略；仅响应
   *              response.output_text.delta 与 response.completed 两类事件。
   
 * @returns 无返回值。
*/
  private handleStreamEvent(event: SseEvent, callbacks: StreamCallbacks, state: StreamState): void {
    if (event.data === '[DONE]') {
      return;
    }
    const json = this.parseEventJson(event.data);
    if (json === undefined) {
      return;
    }
    if (event.event === 'response.output_text.delta') {
      const delta = this.deltaOf(json);
      if (delta !== '') {
        callbacks.onText(delta);
        state.text.push(delta);
      }
      return;
    }
    if (event.event === 'response.completed') {
      const response = json['response'] as ResponsesResponse | undefined;
      if (response !== undefined) {
        state.completed = response;
      }
    }
  }

  /** 提取增量文本。
   * @param json 已解析的事件 JSON 对象。
   * @returns 事件负载中的 delta 字符串；缺失或非字符串时为空串（调用方据此跳过空增量）。
   */
  private deltaOf(json: Record<string, unknown>): string {
    const delta = json['delta'];
    return typeof delta === 'string' ? delta : '';
  }

  /** 解析事件 JSON（无效则忽略）。
   * @param data SSE 事件的 data 负载文本。
   * @returns 解析出的对象；JSON 非法或解析结果不是非空对象时返回 undefined（事件被丢弃）。
   */
  private parseEventJson(data: string): Record<string, unknown> | undefined {
    try {
      const parsed: unknown = JSON.parse(data);
      return typeof parsed === 'object' && parsed !== null
        ? (parsed as Record<string, unknown>)
        : undefined;
    } catch {
      return undefined;
    }
  }

  /** 解析工具参数 JSON。
   * @param raw wire 层返回的参数 JSON 字符串（可能为 undefined 或空串）。
   * @returns 解析出的参数对象；输入为空、JSON 非法或不是对象时返回空对象（不抛错）。
   */
  private parseArguments(raw: string | undefined): Record<string, unknown> {
    if (raw === undefined || raw === '') {
      return {};
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      return typeof parsed === 'object' && parsed !== null
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }
  /**
   * configPrevious — module-level helper moved into ResponsesModel.
   * @param {ResponsesConfig} config - config
   * @returns {string | undefined} - result
   */
  private static configPrevious(config: ResponsesConfig): string | undefined {
    return config.previousResponseId;
  }
}

/** 取配置里的起始续接 ID。
 * @param config 适配器配置。
 * @returns 配置指定的 previousResponseId；未配置时为 undefined（开新会话）。
 */

/** wire 层响应。 */
interface ResponsesResponse {
  readonly id: string;
  readonly output?: readonly ResponsesOutputItem[];
  /** token 用量（#S29）。 */
  readonly usage?: {
    readonly input_tokens: number;
    readonly output_tokens: number;
    readonly total_tokens: number;
    readonly input_tokens_details?: { readonly cached_tokens?: number };
  };
}

/** wire 层输出项：reasoning / message / function_call。 */
interface ResponsesOutputItem {
  readonly type: string;
  readonly call_id?: string;
  readonly name?: string;
  readonly arguments?: string;
  readonly summary?: readonly { readonly text: string }[];
  readonly content?: readonly { readonly text: string }[];
}
