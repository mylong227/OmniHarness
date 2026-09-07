/** 单个 SSE 事件。 */
export interface SseEvent {
  readonly event: string;
  readonly data: string;
}

/** SSE 解析器：从流式响应逐事件解析（OpenAI / Anthropic 共用）。 */
export class SseParser {
  /** 读取流并回调每个事件。 */
  static async read(
    stream: ReadableStream<Uint8Array>,
    onEvent: (event: SseEvent) => void,
  ): Promise<void> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      const blocks = buffer.split('\n\n');
      buffer = blocks.pop() ?? '';
      for (const block of blocks) {
        this.emitBlock(block, onEvent);
      }
    }
    buffer += decoder.decode();
    if (buffer.trim() !== '') {
      this.emitBlock(buffer, onEvent);
    }
  }

  /** 解析单个事件块并回调。 */
  private static emitBlock(block: string, onEvent: (event: SseEvent) => void): void {
    let eventName = 'message';
    const dataLines: string[] = [];
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) {
        eventName = line.slice(6).trim();
      } else if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).trimStart());
      }
    }
    if (dataLines.length > 0) {
      onEvent({ event: eventName, data: dataLines.join('\n') });
    }
  }
}
