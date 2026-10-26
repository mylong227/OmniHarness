/**
 * Harness 崩溃自动重启策略（纯逻辑，可在 node:test 里直接跑）。
 *
 * 目的：单次崩溃自动拉起，但不让崩溃循环无限重启。窗口内超过上限即放弃，交回对话框。
 */
export class HarnessRestartPolicy {
  private readonly stamps: number[] = [];

  /**
   * @param maxRestarts 时间窗口内最多自动重启次数（≥1）。
   * @param windowMs 统计窗口（ms）。
   */
  public constructor(
    private readonly maxRestarts: number,
    private readonly windowMs: number,
  ) {}

  /**
   * 申请一次自动重启。
   * @param now 当前时刻（ms；测试可注入）。
   * @returns 允许重启为 true；已达上限为 false。
   */
  public allow(now: number): boolean {
    const cutoff = now - this.windowMs;
    while (this.stamps.length > 0 && (this.stamps[0] ?? 0) < cutoff) this.stamps.shift();
    if (this.stamps.length >= this.maxRestarts) return false;
    this.stamps.push(now);
    return true;
  }

  /** 清空计数（用户手动重启/恢复后调用）。 */
  public reset(): void {
    this.stamps.length = 0;
  }
}
