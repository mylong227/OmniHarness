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
import { ModelRequestGuard } from './modelRequestGuard.js';
import { RequestStallGuard } from './requestStallGuard.js';
import { ModelHttpErrors } from './modelHttpErrors.js';
import { sseParser, type SseEvent } from './sseParser.js';
import { log } from '../../util/logger.js';

/**
 * @beta
 * Responses API 适配器配置。
 */
export interface ResponsesConfig {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
  /**
   * 起始续接 ID（**已废弃，仅保留 API 兼容**）：2026-10-03 修 D2 后请求体不再回传
   * `previous_response_id`（全量 input 自足；续接锚点与「每步投影完整历史 + 可压缩」
   * 的调用方架构不相容，见 `bodyOf` 说明）。字段保留只为既有构造点不破。
   * @deprecated 不再参与请求构造。
   */
  readonly previousResponseId?: string;
  /** 是否让服务端保存上下文（2026-10-03 修 D2 后默认 **false**；无锚点消费，存储纯属白付费）。 */
  readonly store?: boolean;
  /**
   * 单次请求的**空闲**超时（毫秒，可选）：连续静默超过该值即中止并抛可重试错误。
   * 优先级 本字段 > 环境变量 `OMNI_MODEL_REQUEST_TIMEOUT_MS` > 库级默认；`<=0` 关闭空闲超时。
   */
  readonly requestTimeoutMs?: number | undefined;
}

/** 流式累积状态。 */
interface StreamState {
  readonly text: string[];
  completed: ResponsesResponse | undefined;
}

/**
 * @beta
 * OpenAI Responses API 原生适配器：instructions 独立字段 + 扁平工具 + previous_response_id 服务端续接。
 *
 * **能力边界（如实声明）**：本通路的 wire 序列化只覆盖**文本与工具调用**；
 * `ModelMessage.images` / `.files` 发不出去，运行期由 {@link ResponsesModel.warnDroppedAttachments}
 * 记 `model.responses.attachments_dropped` 告警（**不静默、也不发空占位**）。
 * 需要多模态请用 `openai` / `anthropic` 适配器。
 */
export class ResponsesModel implements ModelPort {
  /** 适配器名（端口契约），取配置的模型标识（config.model）。 */
  public readonly name: string;
  /** 最近一次响应返回的续接 ID（**仅观测记录**：2026-10-03 修 D2 后不再随请求回传，
   *  保留它是为了诊断与既有 `responseId()` API；请求体语义见 {@link ResponsesModel.bodyOf}）。 */
  private lastResponseId: string | undefined;
  /** 提示缓存读取器：Responses 用 `input_tokens_details.cached_tokens` 表达命中。 */
  private readonly promptCache = new PromptCacheUsageReader();
  /** 请求空闲超时装配器（S2）：裸 fetch 在服务端不回包时会永不 settle ⇒ 必须收敛为有界等待。 */
  private readonly guard: ModelRequestGuard;

  public constructor(
    /** 适配器配置：端点地址、API 密钥、模型标识与续接/存储选项。 */
    private readonly config: ResponsesConfig,
  ) {
    this.name = config.model;
    this.lastResponseId = config.previousResponseId;
    this.guard = new ModelRequestGuard(config.requestTimeoutMs);
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
    const guard = this.guard.open(request);
    try {
      const response = await fetch(this.endpoint(), this.buildRequest(request, false, guard));
      guard?.touch();
      if (!response.ok) {
        // 2026-10-03 修（审计 D1）：裸 `Error` 无 status/retryable 字段，429/5xx 永不重试。
        throw await ModelHttpErrors.from(response, '模型请求失败');
      }
      const body = (await response.json()) as ResponsesResponse;
      return this.parseOutput(body);
    } catch (error) {
      throw this.guard.wrap(error, guard, 'Responses 模型请求');
    } finally {
      guard?.dispose();
    }
  }

  /** 流式生成（SSE：文本增量实时回调，终态以 response.completed 为准）。
   * @param request 模型请求（消息列表、工具规格与可选取消信号）。
   * @param callbacks 流式回调集合：文本增量经 onText 实时推送。
   * @returns 流结束后的完整输出：优先取 response.completed 终态事件的解析结果，
   *          若流中断未收到终态则退回已累积文本拼接；响应体缺失时降级为非流式 generate。
   */
  public async stream(request: ModelRequest, callbacks: StreamCallbacks): Promise<ModelOutput> {
    const guard = this.guard.open(request);
    try {
      return await this.streamRequest(request, callbacks, guard);
    } catch (error) {
      throw this.guard.wrap(error, guard, 'Responses 模型流式请求');
    } finally {
      guard?.dispose();
    }
  }

  /**
   * 流式生成主体（守卫生命周期由 `stream` 掌管）。
   * @param request 模型请求。
   * @param callbacks 流式回调集合。
   * @param guard 本次请求的空闲超时守卫（`undefined` = 既无空闲超时也无调用方信号）。
   * @returns 流结束后的完整输出。
   */
  private async streamRequest(
    request: ModelRequest,
    callbacks: StreamCallbacks,
    guard: RequestStallGuard | undefined,
  ): Promise<ModelOutput> {
    const response = await fetch(this.endpoint(), this.buildRequest(request, true, guard));
    guard?.touch();
    if (!response.ok) {
      // 2026-10-03 修（审计 D1）：同 generate 路径，结构化错误让 429/5xx 可重试。
      throw await ModelHttpErrors.from(response, '模型流式请求失败');
    }
    const streamBody = response.body;
    if (streamBody === null) {
      return this.generate(request);
    }
    const state: StreamState = { text: [], completed: undefined };
    await sseParser.read(streamBody, (event) => {
      // 每个 SSE 事件块都算「有进展」：只要流持续吐字，长响应就不会被空闲超时误杀。
      guard?.touch();
      this.handleStreamEvent(event, callbacks, state);
    });
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
   * @param guard 本次请求的空闲超时守卫（可选）；给出时以其组合信号作为 fetch signal。
   * @returns 可直接交给 fetch 的 RequestInit（POST 方法、鉴权头与 JSON 序列化后的请求体）。
   */
  private buildRequest(
    request: ModelRequest,
    stream: boolean,
    guard?: RequestStallGuard,
  ): RequestInit {
    return {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ ...this.bodyOf(request), stream }),
      // V2：协作式取消——signal 存在时透传给 fetch，取消即中断在飞请求。
      // S2：改为守卫的组合信号（空闲超时 ∪ 调用方取消），二者任一触发都中断在飞请求。
      ...(guard !== undefined
        ? { signal: guard.signal }
        : request.signal !== undefined
          ? { signal: request.signal }
          : {}),
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

  /**
   * 请求体。
   *
   * **不再回传 `previous_response_id`（2026-10-03 修，审计 D2）**：本 harness 的调用方
   * （stepContextBuilder）每步都投影**完整事件历史**——全量 input 本就自足；此前在
   * `lastResponseId` 存在时又追加续接锚点，服务端会把已存的对话前置、客户端再原样发一遍，
   * 自第二回合起历史在 prompt 里成倍重复（输入 token 近乎翻倍，且逐回合累积）。
   * 且压缩（compaction）会改写投影历史，服务端锚点根本无法表达「历史被折叠」⇒
   * 全量 input 是与本 harness 架构唯一自洽的模式。`store` 也相应默认 **false**：
   * 没有锚点消费，服务端存储纯属白付费（可经 config.store 显式开启）。
   *
   * @param request 模型请求，提供消息与工具规格。
   * @returns Responses API 请求体：model/input/tools/store，外加 instructions（非空时）。
   */
  private bodyOf(request: ModelRequest): Record<string, unknown> {
    this.warnDroppedAttachments(request.messages);
    const { instructions, input } = this.splitSystem(request.messages);
    const body: Record<string, unknown> = {
      model: this.config.model,
      input,
      tools: this.toWireTools(request.tools),
      store: this.config.store ?? false,
    };
    if (instructions !== '') {
      body['instructions'] = instructions;
    }
    return body;
  }

  /**
   * 附件（图像 / 文件）在本通路上**发不出去**——显式告警，绝不静默。
   *
   * 为什么要有它（2026-10-11 取证）：`splitSystem` 把每条消息投影成 `{role, content}`，
   * 而 `ModelMessage.images` / `.files` 根本不在投影里 ⇒ 用户在会话里贴的图会**无声消失**，
   * 模型照着纯文本作答，而调用方以为图已经发出去了。同仓 `llamaCppModel` 至少记一条 debug，
   * 这里连 debug 都没有——属"声明与实现不一致"（`viewImageTool` 只声明 openai/anthropic 支持，
   * 说明边界本来是清楚的，但**没有任何运行期信号**）。
   *
   * 处置口径：**不改协议序列化**（本仓纪律：无真实样本不推断 Responses 的多模态 wire 格式），
   * 只把"丢了什么、该换哪条通路"如实报出来。要真正支持，须先取得该 API 的可复核样本。
   * @param messages 即将发出的消息列表。
   * @returns 无返回值。
   */
  private warnDroppedAttachments(messages: readonly ModelRequest['messages'][number][]): void {
    let images = 0;
    let files = 0;
    for (const message of messages) {
      images += message.images?.length ?? 0;
      files += message.files?.length ?? 0;
    }
    if (images === 0 && files === 0) {
      return;
    }
    log.warn('model.responses.attachments_dropped', {
      images,
      files,
      hint:
        'Responses 通路只序列化文本与工具调用；多模态附件请改用 openai 或 anthropic 适配器' +
        '（本适配器**不**发送空占位，以免模型以为收到了附件）',
    });
  }

  /**
   * 拆分 system 消息（Responses API 用独立 `instructions` 字段）。
   *
   * **只有开头连续的 system 消息**才提升进 `instructions`；出现在事件历史**之后**的 system
   * 消息（典型：每步随查询变化的 repo-map 尾段）**留在原位**（Responses 的 `input` 项本就允许
   * `role:'system'`）。理由与 Anthropic 适配器同源：`instructions` 排在**所有 input 之前**，
   * 把逐步变化的尾段提升上去会让其后整段事件历史每步都重新计费——`StepContextBuilder` 的
   * 「动态段置尾」治理（P_prefix）会在 wire 层被静默撤销。
   *
   * @param messages 完整消息列表。
   * @returns `instructions`（开头连续 system 以空行拼接；无则空串）与 `input` 数组
   *          （保留原角色与顺序，头部 system 已被剥离）。
   */
  private splitSystem(messages: readonly ModelRequest['messages'][number][]): {
    instructions: string;
    input: unknown[];
  } {
    let head = 0;
    while (head < messages.length && messages[head]?.role === 'system') {
      head += 1;
    }
    return {
      instructions: messages
        .slice(0, head)
        .map((message) => message.content)
        .join('\n\n'),
      input: messages.slice(head).map((message) => ({
        role: message.role,
        content: message.content,
      })),
    };
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
    // 流中错误事件（2026-10-03 修，审计 D3）：`error` 与 `response.failed` 负载此前被静默
    // 丢弃，半截输出被当成成功。出现即中断流并上抛结构化错误（overloaded/限流可重试）。
    if (event.event === 'error' || event.event === 'response.failed') {
      const err = json['error'];
      const info =
        typeof err === 'object' && err !== null
          ? (err as { code?: string; type?: string; message?: string })
          : undefined;
      throw ModelHttpErrors.streamError(
        'Responses',
        info?.code ?? info?.type ?? event.event,
        info?.message ?? '',
      );
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
   * JSON 非法时**必留 warn**（2026-10-03 修，审计 D5）：参数被截断/流中断是真实根因，
   * 静默 `{}` 会让工具带着空参数执行、下游只见「工具失败」而无从归因。
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
      log.warn('model.tool_arguments.invalid_json', {
        raw: raw.slice(0, 200),
        rawLength: raw.length,
      });
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
