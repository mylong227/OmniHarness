/**
 * Laya 常驻进程的 **JSONL 分帧器**：把 stdout 的任意字节片段拼成完整的一行行 JSON。
 *
 * ## 为什么独立成类
 *
 * 「按行分帧」与「进程生命周期编排」是两件事：前者是纯函数式状态机（喂字节、吐整行），
 * 后者管 spawn / 超时 / 回收 / 存活性。混在一个类里会让后者的成员数越过
 * `scripts/auditStandards.mjs` 的「上帝类」判据（含类文件 >25 成员即红）——按本仓惯例
 * **抽出去而不是放宽阈值**。
 *
 * 分帧为什么必须自己写：子进程的 stdout 会被任意切分（一个 JSON 帧可能横跨两个 chunk），
 * 直接 `JSON.parse(chunk)` 在真实负载下必然偶发失败，而这类失败的表现是「随机丢一次决策」。
 */
export class LayaJsonlFramer {
  /** 尚未凑齐整行的残留字节。 */
  private buffer = '';

  /**
   * 喂入一段字节，按 `\n` 切出完整行并逐行回调（行内首尾空白已剔除；空行跳过）。
   *
   * @param chunk 新到的字节片段。
   * @param onLine 完整行的回调（同步调用）。
   * @returns 本次切出的完整行数。
   */
  public feed(chunk: Buffer, onLine: (line: string) => void): number {
    this.buffer += chunk.toString('utf8');
    let count = 0;
    for (;;) {
      const index = this.buffer.indexOf('\n');
      if (index < 0) {
        return count;
      }
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (line.length > 0) {
        count += 1;
        onLine(line);
      }
    }
  }

  /**
   * 清空残留缓冲（进程重启 / 回收时调用：旧进程的半截帧不得污染新进程的解析）。
   *
   * @returns 无返回值。
   */
  public reset(): void {
    this.buffer = '';
  }
}
