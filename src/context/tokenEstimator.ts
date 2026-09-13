/** Token 估算器：中文按字数计，其余按 4 字符/token 近似。 */
export class TokenEstimator {
  /** 原生（Rust 内核）估算器：注入后 estimateMessages 走原生路径（单次 FFI 往返）。 */
  private nativeEstimator?: (messages: readonly { content: string }[]) => number;

  /** 注入原生（Rust 内核）批量估算器；传入则 estimateMessages 优先走原生。
   * @returns 无返回值。
   */
  public setNativeEstimator(fn: (messages: readonly { content: string }[]) => number): void {
    this.nativeEstimator = fn;
  }

  /** 估算单段文本 token 数。 */
  public estimate(text: string): number {
    const cjk = this.countCjk(text);
    const other = text.length - cjk;
    return Math.ceil(cjk + other / 4);
  }

  /** 估算消息列表 token 数（含每条角色开销）。 */
  public estimateMessages(messages: readonly { content: string }[]): number {
    if (this.nativeEstimator !== undefined) {
      return this.nativeEstimator(messages);
    }
    return messages.reduce((sum, message) => sum + this.estimate(message.content) + 4, 0);
  }

  /** 统计中日韩字符数量。 */
  private countCjk(text: string): number {
    const matches = text.match(/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g);
    return matches === null ? 0 : matches.length;
  }
}
