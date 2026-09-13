/** 单个 SSE 事件。 */
export interface SseEvent {
  readonly event: string;
  readonly data: string;
}

/** SSE 解析器：从流式响应逐事件解析（OpenAI / Anthropic 共用）。 */
export class SseParser {
  /** 读取流并回调每个事件。
   * 协议行为：按 SSE 规范以空行（\n\n）分帧；跨块字节数据先经 TextDecoder 流式解码再拼接，
   * 不完整的事件块留待下一块；流结束后把残余缓冲尽力发出（非空才回调）。
   * @param stream 响应体字节流。
   * @param onEvent 每解析出一个完整事件块回调一次（含 event 名与 data 文本）。
   
 * @returns 无返回值。
*/
  public async read(
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

  /** 解析单个事件块并回调。
   * @param block 单个 SSE 事件块文本（以空行分隔的若干 `event:` / `data:` 行）。
   * @param onEvent 事件回调；同一块多条 data 行按 SSE 规范以换行拼接，无 data 行则不回调，
   *                缺省 event 名按规范取 'message'。
   
 * @returns 无返回值。
*/
  private emitBlock(block: string, onEvent: (event: SseEvent) => void): void {
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

/** 默认实例（无状态、可并发复用，调用点以 `sseParser.xxx` 零构造复用）。 */
export const sseParser = new SseParser();
