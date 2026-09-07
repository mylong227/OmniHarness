import type {
  ModelOutput,
  ModelPort,
  ModelRequest,
  ModelToolCallRef,
  ModelToolSpec,
  ModelUsage,
  StreamCallbacks,
} from '../../ports/model.js';
import { SseParser, type SseEvent } from './sseParser.js';

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
  readonly name: string;
  private lastResponseId: string | undefined;

  constructor(private readonly config: ResponsesConfig) {
    this.name = config.model;
    this.lastResponseId = config.previousResponseId;
  }

  /** 当前续接 ID（下一轮请求带上，由服务端持有历史上下文）。 */
  responseId(): string | undefined {
    return this.lastResponseId;
  }

  /** 重置续接锚点（开新会话；服务端上下文不复用）。 */
  reset(): void {
    this.lastResponseId = configPrevious(this.config);
  }

  /** 生成响应。 */
  async generate(request: ModelRequest): Promise<ModelOutput> {
    const response = await fetch(this.endpoint(), this.buildRequest(request, false));
    if (!response.ok) {
      throw new Error(`模型请求失败: HTTP ${response.status}`);
    }
    const body = (await response.json()) as ResponsesResponse;
    return this.parseOutput(body);
  }

  /** 流式生成（SSE：文本增量实时回调，终态以 response.completed 为准）。 */
  async stream(request: ModelRequest, callbacks: StreamCallbacks): Promise<ModelOutput> {
    const response = await fetch(this.endpoint(), this.buildRequest(request, true));
    if (!response.ok) {
      throw new Error(`模型流式请求失败: HTTP ${response.status}`);
    }
    const streamBody = response.body;
    if (streamBody === null) {
      return this.generate(request);
    }
    const state: StreamState = { text: [], completed: undefined };
    await SseParser.read(streamBody, (event) => this.handleStreamEvent(event, callbacks, state));
    return state.completed === undefined
      ? { text: state.text.join('') }
      : this.parseOutput(state.completed);
  }

  /** 构造请求端点。 */
  private endpoint(): string {
    return `${this.config.baseUrl}/responses`;
  }

  /** 构造请求体（stream 时不带 previous_response_id 亦可，此处统一带上以支持续接）。 */
  private buildRequest(request: ModelRequest, stream: boolean): RequestInit {
    return {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ ...this.bodyOf(request), stream }),
    };
  }

  /** 请求头。 */
  private headers(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.config.apiKey}`,
    };
  }

  /** 请求体。 */
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

  /** 提取 system 指令（Responses API 用独立 instructions 字段）。 */
  private instructionsOf(messages: readonly ModelRequest['messages'][number][]): string {
    return messages
      .filter((message) => message.role === 'system')
      .map((message) => message.content)
      .join('\n\n');
  }

  /** 消息转 wire 输入（system 已剥离到 instructions）。 */
  private toWireInput(messages: readonly ModelRequest['messages'][number][]): unknown[] {
    return messages
      .filter((message) => message.role !== 'system')
      .map((message) => ({ role: message.role, content: message.content }));
  }

  /** 工具转 wire 格式（Responses 为扁平结构，无 function 嵌套）。 */
  private toWireTools(tools: readonly ModelToolSpec[]): unknown[] {
    return tools.map((tool) => ({
      type: 'function',
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    }));
  }

  /** 解析响应为统一输出，并记录续接锚点。 */
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
    if (body.usage !== undefined) {
      output.usage = {
        promptTokens: body.usage.input_tokens,
        completionTokens: body.usage.output_tokens,
        totalTokens: body.usage.total_tokens,
      };
    }
    return output;
  }

  /** 收集 reasoning 摘要文本。 */
  private collectReasoning(items: readonly ResponsesOutputItem[]): string {
    return items
      .filter((item) => item.type === 'reasoning')
      .flatMap((item) => item.summary ?? [])
      .map((entry) => entry.text)
      .join('\n');
  }

  /** 收集输出文本。 */
  private collectText(items: readonly ResponsesOutputItem[]): string {
    return items
      .filter((item) => item.type === 'message')
      .flatMap((item) => item.content ?? [])
      .map((entry) => entry.text)
      .join('');
  }

  /** 收集函数调用。 */
  private collectToolCalls(items: readonly ResponsesOutputItem[]): readonly ModelToolCallRef[] {
    return items
      .filter((item) => item.type === 'function_call' && item.name !== undefined)
      .map((item) => ({
        id: item.call_id ?? '',
        name: item.name ?? '',
        arguments: this.parseArguments(item.arguments),
      }));
  }

  /** 处理流式事件。 */
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

  /** 提取增量文本。 */
  private deltaOf(json: Record<string, unknown>): string {
    const delta = json['delta'];
    return typeof delta === 'string' ? delta : '';
  }

  /** 解析事件 JSON（无效则忽略）。 */
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

  /** 解析工具参数 JSON。 */
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
}

/** 取配置里的起始续接 ID。 */
function configPrevious(config: ResponsesConfig): string | undefined {
  return config.previousResponseId;
}

/** wire 层响应。 */
interface ResponsesResponse {
  readonly id: string;
  readonly output?: readonly ResponsesOutputItem[];
  /** token 用量（#S29）。 */
  readonly usage?: {
    readonly input_tokens: number;
    readonly output_tokens: number;
    readonly total_tokens: number;
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
