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
    /** 下一次找分隔符的起点；保留尾部 3 字符以覆盖跨 chunk 的半截终止符。 */
    let searchFrom = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        buffer += decoder.decode(value, { stream: true });
        // 增量分帧（2026-10-25）：只扫描新增长度 + 尾部 3 字符，不再对已累积的整个 buffer
        // 做 replace + split。旧实现对「单个 200 KB 事件按 1 KB chunk 到达」是 O(n²)：
        // 实测 195 ms（256 B chunk）且随事件长度平方增长；现在与事件长度线性。
        let start = 0;
        for (;;) {
          const boundary = SseParser.findBoundary(buffer, searchFrom);
          if (boundary === null) break;
          const block = buffer.slice(start, boundary.index);
          if (block.trim() !== '') this.emitBlock(block, onEvent);
          start = boundary.index + boundary.length;
          searchFrom = start;
        }
        if (start > 0) {
          buffer = buffer.slice(start);
          searchFrom = 0;
        } else {
          // 未切出完整块：下一次只回看最后 3 个字符（最长终止符 `\r\n` ×2 = 4，跨块时需重叠 3）。
          searchFrom = Math.max(0, buffer.length - 3);
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

  /**
   * 在 buffer 中找下一个空行分帧边界（LF / CRLF / CR 三态，允许混用）。
   *
   * 边界 = 连续两个行终止符；返回第一个终止符的下标与总长度。块内容由调用方切出后
   * 再归一 CRLF/CR —— 只归一**本块**，避免反复处理历史文本。
   * @param buffer 累积文本。
   * @param from 起始下标（调用方保证不越过未完成的尾部）。
   * @returns 边界；不存在时为 null。
   */
  private static findBoundary(
    buffer: string,
    from: number,
  ): { readonly index: number; readonly length: number } | null {
    for (let index = from; index < buffer.length; index += 1) {
      const first = SseParser.terminatorLength(buffer, index);
      if (first === 0) continue;
      const second = SseParser.terminatorLength(buffer, index + first);
      if (second !== 0) return { index, length: first + second };
    }
    return null;
  }

  /**
   * 下标处的行终止符长度（`\r\n`=2、`\n`=1、`\r`=1、其他=0）。
   * @param text 文本。
   * @param index 下标。
   * @returns 长度。
   */
  private static terminatorLength(text: string, index: number): number {
    const char = text[index];
    if (char === '\n') return 1;
    if (char !== '\r') return 0;
    return text[index + 1] === '\n' ? 2 : 1;
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
    // 只归一**本块**的行终止符：分帧阶段已按原始终止符切块，这里不再碰历史文本。
    const normalized = block.replace(/\r\n/gu, '\n').replace(/\r/gu, '\n');
    for (const line of normalized.split('\n')) {
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
