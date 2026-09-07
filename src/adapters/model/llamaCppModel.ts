import type {
  ModelOutput,
  ModelPort,
  ModelRequest,
  ModelToolCallRef,
  ModelToolSpec,
  ModelUsage,
  StreamCallbacks,
} from '../../ports/model.js';
import { ModelCallError } from '../../ports/model.js';

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
  readonly apiKey?: string;
}

/**
 * @beta
 * 本地模型（Ollama / llama.cpp 原生 `/api/chat`）适配器。
 */
export class LlamaCppModel implements ModelPort {
  readonly name: string;
  private readonly config: LlamaCppConfig;

  constructor(config: LlamaCppConfig) {
    this.config = config;
    this.name = config.model;
  }

  /** 非流式生成。 */
  async generate(request: ModelRequest): Promise<ModelOutput> {
    const response = await fetch(
      `${this.config.baseUrl}/api/chat`,
      this.buildRequest(request, false),
    );
    if (!response.ok) {
      throw this.httpError(response, '本地模型请求失败');
    }
    const body = (await response.json()) as OllamaChatResponse;
    return this.parseOutput(body);
  }

  /** 流式生成：Ollama 以换行分隔的 JSON 对象（NDJSON）推送，末条 done:true 收尾。 */
  async stream(request: ModelRequest, callbacks: StreamCallbacks): Promise<ModelOutput> {
    const response = await fetch(
      `${this.config.baseUrl}/api/chat`,
      this.buildRequest(request, true),
    );
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

  /** 构造请求体。 */
  private buildRequest(request: ModelRequest, stream: boolean): RequestInit {
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
    return { method: 'POST', headers, body: JSON.stringify(body) };
  }

  /** 工具转 Ollama 原生格式（与 OpenAI 一致，但参数对象原样下发）。 */
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

  /** 把 Ollama 响应解析为统一输出。 */
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

  /** 把 Ollama 工具调用统一为 ModelToolCallRef（Ollama 不给 id，以函数名代替）。 */
  private toToolCallRef(call: OllamaToolCall): ModelToolCallRef {
    const args =
      typeof call.function.arguments === 'string'
        ? this.parseArguments(call.function.arguments)
        : call.function.arguments;
    return { id: call.function.name, name: call.function.name, arguments: args };
  }

  /** 流式工具调用增量合入（按函数名去重，后到覆盖参数）。 */
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

  /** 解析工具参数 JSON（容错：非法则回退空对象）。 */
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

  /** 从流式片段顶层提取 usage（Ollama 在 done 段返回 prompt_eval_count / eval_count）。 */
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

  /** 非 2xx 转结构化错误（5xx / 429 标可重试）。 */
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
