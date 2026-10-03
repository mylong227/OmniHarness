/** 单个 SSE 事件。 */
export interface SseEvent {
  readonly event: string;
  readonly data: string;
}

/** SSE 解析器：从流式响应逐事件解析（OpenAI / Anthropic / Responses 共用）。 */
export class SseParser {
  /** 读取流并回调每个事件。
   * 协议行为：按 SSE 规范以空行分帧；行终止符 LF / CRLF / CR 三态都认（2026-10-03 修：
   * 旧实现只认 `\n\n`，遇到以 CRLF 分帧的服务器/代理时整条流塌缩成一个块，多事件 data 行
   * 被拼接后 JSON.parse 必炸）；跨块字节数据先经 TextDecoder 流式解码再拼接，不完整的事件块
   * 留待下一块；流结束后把残余缓冲尽力发出（非空才回调）。
   *
   * 连接清理（2026-10-03 修）：读取循环包 `finally`——正常结束或 `onEvent` 抛错（如适配器
   * 对流中 error 事件上抛）都取消 reader，释放底层连接；旧实现异常路径既不 cancel 也不
   * releaseLock，socket 依赖 GC 回收，反复错误下会耗尽连接池。
   *
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
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        buffer += decoder.decode(value, { stream: true });
        // SSE 规范：行终止符可为 LF、CRLF 或裸 CR，统一归一为 LF 再分帧
        //（残余块可能以半个 CRLF 结尾，归一放在每次拼接后即可，CR 不会横跨 split 边界残留）。
        buffer = buffer.replace(/\r\n/gu, '\n').replace(/\r/gu, '\n');
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
    } finally {
      // 失败/中断路径也释放连接；正常完成后 cancel 是无害 no-op。取消失败静默（清理兜底）。
      await reader.cancel().catch(() => undefined);
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
