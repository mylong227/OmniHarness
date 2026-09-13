/**
 * @beta
 * 并发闸门：限制同时运行的任务数（信号量语义，槽位直接移交等待者）。
 */
export class ConcurrencyLimiter {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  public constructor(private readonly limit: number) {}

  /** 当前活跃任务数（观测用）。 */
  public activeCount(): number {
    return this.active;
  }

  /** 并发上限。 */
  public limitOf(): number {
    return this.limit;
  }

  /** 获取一个执行槽位；已达上限时挂起等待。
   * @returns 无返回值。
   */
  public async acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active += 1;
      return;
    }
    await new Promise<void>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  /** 释放槽位；有等待者时直接移交（活跃数不变，避免越过上限）。
   * @returns 无返回值。
   */
  public release(): void {
    const next = this.waiters.shift();
    if (next !== undefined) {
      next();
      return;
    }
    this.active -= 1;
  }

  /** 在闸门约束下执行任务（异常也保证释放）。 */
  public async run<T>(task: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await task();
    } finally {
      this.release();
    }
  }
}
