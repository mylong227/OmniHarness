import type {
  ModelOutput,
  ModelPort,
  ModelRequest,
  ModelToolCallRef,
  ModelToolSpec,
  ModelUsage,
  StreamCallbacks,
} from '../../ports/model/model.js';
import { ModelCallError } from '../../ports/model/model.js';
import { ModelRequestGuard } from './modelRequestGuard.js';
import { RequestStallGuard } from './requestStallGuard.js';

/**
 * @beta
 * 本地模型原生适配器（B5）：对接 Ollama / llama.cpp 原生协议。
 *
 * 端点：`<baseUrl>/api/chat`（Ollama 原生 chat 协议，也是本地模型最成熟、且原生支持
 * 工具调用与流式（NDJSON）的端口）。llama.cpp 的 `server` 同时提供 OpenAI 兼容的
 * `/v1`，那类端点直接走 `openai` 适配器 + `--base-url` 即可；本适配器补齐「原生」缺口。
 *
 * 默认 baseUrl = http://localhost:11434（Ollama 默认端口），无需外网、零密钥即可跑。
 */
export interface LlamaCppConfig {
  /** 本地服务基址，如 http://localhost:11434。 */
  readonly baseUrl: string;
  /** 模型名，如 llama3 / qwen2.5。 */
  readonly model: string;
  /** 可选鉴权（vLLM 等需 Bearer）。Ollama 通常留空。 */
  readonly apiKey?: string | undefined;
  /**
   * 单次请求的**空闲**超时（毫秒，可选）：连续静默超过该值即中止并抛可重试错误。
   * 优先级 本字段 > 环境变量 `OMNI_MODEL_REQUEST_TIMEOUT_MS` > 库级默认；`<=0` 关闭空闲超时。
   */
  readonly requestTimeoutMs?: number | undefined;
}

/**
 * @beta
 * 本地模型（Ollama / llama.cpp 原生 `/api/chat`）适配器。
 */
export class LlamaCppModel implements ModelPort {
  /** 适配器名（端口契约），取配置的模型标识（config.model）。 */
  public readonly name: string;
  /** 适配器配置：本地服务基址、模型名与可选鉴权。 */
  private readonly config: LlamaCppConfig;
  /** 请求空闲超时装配器（S2）：本地服务卡死时裸 fetch 会永不 settle ⇒ 必须收敛为有界等待。 */
  private readonly guard: ModelRequestGuard;

  public constructor(config: LlamaCppConfig) {
    this.config = config;
    this.name = config.model;
    this.guard = new ModelRequestGuard(config.requestTimeoutMs);
  }

  /** 非流式生成。
   * @param request 模型请求（消息与工具规格）。
   * @returns 解析后的统一输出（文本、工具调用与 token 用量）；非 2xx 时抛出结构化 ModelCallError。
   */
  public async generate(request: ModelRequest): Promise<ModelOutput> {
    const guard = this.guard.open(request);
    try {
      const response = await fetch(
        `${this.config.baseUrl}/api/chat`,
        this.buildRequest(request, false, guard),
      );
      guard?.touch();
      if (!response.ok) {
        throw this.httpError(response, '本地模型请求失败');
      }
      const body = (await response.json()) as OllamaChatResponse;
      return this.parseOutput(body);
    } catch (error) {
      throw this.guard.wrap(error, guard, '本地模型请求');
    } finally {
      guard?.dispose();
    }
  }

  /** 流式生成：Ollama 以换行分隔的 JSON 对象（NDJSON）推送，末条 done:true 收尾。
   * @param request 模型请求（消息与工具规格）。
   * @param callbacks 流式回调集合：文本增量实时推送；工具调用去重合入后不逐段回调。
   * @returns 流结束后的完整输出：文本按增量顺序拼接，工具调用跨片段合并（按函数名去重、
   *          后到覆盖参数），usage 取最后一个含计数字段的片段。响应体缺失时降级为非流式 generate；
   *          末尾无换行的残余 JSON 片段尽力解析，非法则忽略；非 2xx 时抛出结构化错误。
   */
  public async stream(request: ModelRequest, callbacks: StreamCallbacks): Promise<ModelOutput> {
    const guard = this.guard.open(request);
    try {
      return await this.streamRequest(request, callbacks, guard);
    } catch (error) {
      throw this.guard.wrap(error, guard, '本地模型流式请求');
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
    const response = await fetch(
      `${this.config.baseUrl}/api/chat`,
      this.buildRequest(request, true, guard),
    );
    guard?.touch();
    if (!response.ok) {
      throw this.httpError(response, '本地模型流式请求失败');
    }
    const body = response.body;
    if (body === null) {
      return this.generate(request);
    }
    const chunks: string[] = [];
    const toolCalls: { id: string; name: string; arguments: Record<string, unknown> }[] = [];
    let usage: ModelUsage | undefined;
    const decoder = new TextDecoder();
    let buffer = '';
    for await (const piece of body) {
      // 每一块 NDJSON 数据都算「有进展」：只要流持续吐字，长响应就不会被空闲超时误杀。
      guard?.touch();
      buffer += decoder.decode(piece, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (line === '') {
          continue;
        }
        const obj = JSON.parse(line) as OllamaChatStreamChunk;
        if (obj.message?.content !== undefined && obj.message.content !== '') {
          callbacks.onText(obj.message.content);
          chunks.push(obj.message.content);
        }
        if (obj.message?.tool_calls !== undefined) {
          this.mergeToolCalls(toolCalls, obj.message.tool_calls);
        }
        usage = this.usageFromChunk(obj, usage);
        if (obj.done === true) {
          break;
        }
      }
    }
    // 处理末尾未以换行刷新的残余片段。
    const tail = buffer.trim();
    if (tail !== '') {
      try {
        const obj = JSON.parse(tail) as OllamaChatStreamChunk;
        if (obj.message?.content !== undefined && obj.message.content !== '') {
          callbacks.onText(obj.message.content);
          chunks.push(obj.message.content);
        }
        if (obj.message?.tool_calls !== undefined) {
          this.mergeToolCalls(toolCalls, obj.message.tool_calls);
        }
        usage = this.usageFromChunk(obj, usage);
      } catch {
        // 截断片段忽略。
      }
    }
    const output: { text?: string; toolCalls?: ModelToolCallRef[]; usage?: ModelUsage } = {
      text: chunks.join(''),
    };
    if (toolCalls.length > 0) {
      output.toolCalls = toolCalls as ModelToolCallRef[];
    }
    if (usage !== undefined) {
      output.usage = usage;
    }
    return output;
  }

  /** 构造请求体。
   * @param request 模型请求，提供消息与工具规格。
   * @param stream true 表示 NDJSON 流式响应，false 表示一次性 JSON 响应。
   * @param guard 本次请求的空闲超时守卫（可选）；给出时以其组合信号作为 fetch signal。
   * @returns 可直接交给 fetch 的 RequestInit（POST、JSON 请求体；配置了 apiKey 时附 Bearer 头，
   *          signal 存在时透传以支持取消）。
   */
  private buildRequest(
    request: ModelRequest,
    stream: boolean,
    guard?: RequestStallGuard,
  ): RequestInit {
    const tools =
      request.tools.length > 0 ? request.tools.map((tool) => this.toOllamaTool(tool)) : undefined;
    const body: Record<string, unknown> = {
      model: this.config.model,
      messages: request.messages.map((message) => ({
        role: message.role,
        content: message.content,
      })),
      stream,
    };
    if (tools !== undefined) {
      body.tools = tools;
    }
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.config.apiKey !== undefined) {
      headers['Authorization'] = `Bearer ${this.config.apiKey}`;
    }
    return {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      // V2：协作式取消——signal 存在时透传给 fetch，取消即中断在飞请求。
      // S2：改为守卫的组合信号（空闲超时 ∪ 调用方取消），二者任一触发都中断在飞请求。
      ...(guard !== undefined
        ? { signal: guard.signal }
        : request.signal !== undefined
          ? { signal: request.signal }
          : {}),
    };
  }

  /** 工具转 Ollama 原生格式（与 OpenAI 一致，但参数对象原样下发）。
   * @param tool 统一工具规格。
   * @returns Ollama tools 数组元素（type=function 嵌套结构）。
   */
  private toOllamaTool(tool: ModelToolSpec): unknown {
    return {
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      },
    };
  }

  /** 把 Ollama 响应解析为统一输出。
   * @param body wire 层 JSON 响应。
   * @returns 统一模型输出（文本、工具调用与用量）；用量由 prompt_eval_count / eval_count 合成，
   *          两字段皆缺时不含 usage。
   */
  private parseOutput(body: OllamaChatResponse): ModelOutput {
    const output: { text?: string; toolCalls?: ModelToolCallRef[]; usage?: ModelUsage } = {};
    const message = body.message;
    if (message?.content !== undefined && message.content !== '') {
      output.text = message.content;
    }
    if (message?.tool_calls !== undefined && message.tool_calls.length > 0) {
      output.toolCalls = message.tool_calls.map((call) => this.toToolCallRef(call));
    }
    // Ollama 在响应末返回 prompt_eval_count / eval_count（token 用量）。
    if (body.prompt_eval_count !== undefined || body.eval_count !== undefined) {
      const prompt = body.prompt_eval_count ?? 0;
      const completion = body.eval_count ?? 0;
      output.usage = {
        promptTokens: prompt,
        completionTokens: completion,
        totalTokens: prompt + completion,
      };
    }
    return output;
  }

  /** 把 Ollama 工具调用统一为 ModelToolCallRef（Ollama 不给 id，以函数名代替）。
   * @param call wire 层工具调用（arguments 兼容对象与 JSON 字符串两种形态）。
   * @returns 统一工具调用引用；字符串参数经解析，非法回退空对象。
   */
  private toToolCallRef(call: OllamaToolCall): ModelToolCallRef {
    const args =
      typeof call.function.arguments === 'string'
        ? this.parseArguments(call.function.arguments)
        : call.function.arguments;
    return { id: call.function.name, name: call.function.name, arguments: args };
  }

  /** 流式工具调用增量合入（按函数名去重，后到覆盖参数）。
   * @param target 跨片段累积的工具调用列表（就地修改）。
   * @param calls 当前片段携带的工具调用集合；同名调用覆盖参数，新名追加条目。
   
 * @returns 无返回值。
*/
  private mergeToolCalls(
    target: { id: string; name: string; arguments: Record<string, unknown> }[],
    calls: readonly OllamaToolCall[],
  ): void {
    for (const call of calls) {
      const args =
        typeof call.function.arguments === 'string'
          ? this.parseArguments(call.function.arguments)
          : call.function.arguments;
      const existing = target.find((t) => t.name === call.function.name);
      if (existing !== undefined) {
        existing.arguments = args;
      } else {
        target.push({ id: call.function.name, name: call.function.name, arguments: args });
      }
    }
  }

  /** 解析工具参数 JSON（容错：非法则回退空对象）。
   * @param raw wire 层返回的参数 JSON 字符串。
   * @returns 解析出的参数对象；JSON 非法或不是对象时返回空对象（不抛错）。
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

  /** 从流式片段顶层提取 usage（Ollama 在 done 段返回 prompt_eval_count / eval_count）。
   * @param chunk 当前 NDJSON 片段。
   * @param prev 之前累积的用量，用于缺失字段的回填补齐。
   * @returns 合成后的用量；本片段无任何计数字段时原样返回 prev。
   */
  private usageFromChunk(
    chunk: OllamaChatStreamChunk,
    prev: ModelUsage | undefined,
  ): ModelUsage | undefined {
    if (chunk.prompt_eval_count === undefined && chunk.eval_count === undefined) {
      return prev;
    }
    const prompt = chunk.prompt_eval_count ?? prev?.promptTokens ?? 0;
    const completion = chunk.eval_count ?? prev?.completionTokens ?? 0;
    return { promptTokens: prompt, completionTokens: completion, totalTokens: prompt + completion };
  }

  /** 非 2xx 转结构化错误（5xx / 429 标可重试）。
   * @param response fetch 返回的非 2xx 响应。
   * @param label 错误消息前缀（区分普通生成与流式生成）。
   * @returns 携带 status 与 retryable 标记的 ModelCallError（不抛出，由调用方决定）。
   */
  private httpError(response: Response, label: string): ModelCallError {
    const status = response.status;
    const retryable = status === 429 || (status >= 500 && status <= 599);
    return new ModelCallError(`${label}: HTTP ${status}`, { status, retryable });
  }
}

/** Ollama 非流式响应。 */
interface OllamaChatResponse {
  readonly message?: {
    readonly content?: string;
    readonly tool_calls?: readonly OllamaToolCall[];
  };
  readonly prompt_eval_count?: number;
  readonly eval_count?: number;
}

/** Ollama 流式片段（usage 在 done 段以顶层字段返回）。 */
interface OllamaChatStreamChunk {
  readonly message?: {
    content?: string;
    tool_calls?: readonly OllamaToolCall[];
  };
  readonly done?: boolean;
  readonly prompt_eval_count?: number;
  readonly eval_count?: number;
}

/** Ollama 工具调用（arguments 可为对象或 JSON 字符串，两种都兼容）。 */
interface OllamaToolCall {
  readonly function: {
    readonly name: string;
    readonly arguments: Record<string, unknown> | string;
  };
}
