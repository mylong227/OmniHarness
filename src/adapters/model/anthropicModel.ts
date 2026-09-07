import type {
  ImageContent,
  FileAttachment,
  ModelMessage,
  ModelOutput,
  ModelPort,
  ModelRequest,
  ModelToolCallRef,
  ModelToolSpec,
  StreamCallbacks,
} from '../../ports/model.js';
import { SseParser } from './sseParser.js';

/** Anthropic 模型配置。 */
export interface AnthropicModelConfig {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
  readonly maxTokens?: number;
}

/** Anthropic Messages API 适配器（真实第二协议）。 */
export class AnthropicModel implements ModelPort {
  readonly name: string;

  constructor(private readonly config: AnthropicModelConfig) {
    this.name = config.model;
  }

  /** 生成响应。 */
  async generate(request: ModelRequest): Promise<ModelOutput> {
    const response = await fetch(this.endpoint(), this.buildRequest(request));
    if (!response.ok) {
      throw new Error(`Anthropic 请求失败: HTTP ${response.status}`);
    }
    const body = (await response.json()) as AnthropicResponse;
    return this.parseOutput(body);
  }

  /** 流式生成（SSE）。 */
  async stream(request: ModelRequest, callbacks: StreamCallbacks): Promise<ModelOutput> {
    const response = await fetch(this.endpoint(), this.buildRequest(request));
    if (!response.ok) {
      throw new Error(`Anthropic 流式请求失败: HTTP ${response.status}`);
    }
    const body = response.body;
    if (body === null) {
      return this.generate(request);
    }
    const chunks: string[] = [];
    const toolBlocks: { index: number; id?: string; name?: string; partial: string }[] = [];
    await SseParser.read(body, (event) =>
      this.handleEvent(event.data, callbacks, chunks, toolBlocks),
    );
    return { text: chunks.join('') };
  }

  /** 构造端点。 */
  private endpoint(): string {
    return `${this.config.baseUrl}/v1/messages`;
  }

  /** 构造请求。 */
  private buildRequest(request: ModelRequest): RequestInit {
    const { system, messages } = this.splitSystem(request.messages);
    return {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({
        model: this.config.model,
        max_tokens: this.config.maxTokens ?? 4096,
        system,
        messages,
        tools: this.toTools(request.tools),
      }),
    };
  }

  /** 请求头。 */
  private headers(): Record<string, string> {
    return {
      'content-type': 'application/json',
      'x-api-key': this.config.apiKey,
      'anthropic-version': '2023-06-01',
    };
  }

  /** 拆分 system 消息（Anthropic 用独立字段）。 */
  private splitSystem(messages: readonly ModelMessage[]): { system?: string; messages: unknown[] } {
    const system = messages
      .filter((message) => message.role === 'system')
      .map((message) => message.content)
      .join('\n');
    const rest = messages
      .filter((message) => message.role !== 'system')
      .map((message) => ({
        role: message.role === 'tool' ? 'user' : message.role,
        content: this.toWireContent(message),
      }));
    return { system: system === '' ? undefined : system, messages: rest };
  }

  /**
   * 构造单条消息的 content：无图像时保持原字符串（向后兼容）；
   * 含图像时构造为 [text, ...image] 数组（#B1）。
   */
  private toWireContent(message: ModelMessage): unknown {
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

  /** 工具转 Anthropic 格式。 */
  private toTools(tools: readonly ModelToolSpec[]): unknown[] {
    return tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.parameters,
    }));
  }

  /** 解析响应。 */
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
    const output: { text?: string; toolCalls?: readonly ModelToolCallRef[] } = {};
    if (text !== '') {
      output.text = text;
    }
    if (toolCalls.length > 0) {
      output.toolCalls = toolCalls;
    }
    return output;
  }

  /** 处理流式事件。 */
  private handleEvent(
    data: string,
    callbacks: StreamCallbacks,
    chunks: string[],
    toolBlocks: { index: number; id?: string; name?: string; partial: string }[],
  ): void {
    if (data === '[DONE]') {
      return;
    }
    const json = JSON.parse(data) as AnthropicStreamEvent;
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
}

/** Anthropic 响应类型。 */
interface AnthropicResponse {
  readonly content: readonly (TextBlock | ToolUseBlock)[];
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
}
