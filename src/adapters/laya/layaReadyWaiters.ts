/**
 * 「等待权重就绪」的等待者集合（`waitReady` 的簿记）：就绪 / 回收 / 退出时**一次性兑现**，
 * 调用方因此不必轮询。
 *
 * ## 为什么独立成类
 *
 * 它与「进程生命周期编排」是两个关注点，且 `LayaWarmWorker` 的成员数已贴着
 * `scripts/auditStandards.mjs` 的「上帝类」判据（含类文件 >25 成员即红）——按本仓惯例
 * **抽出去而不是放宽阈值**。
 *
 * ## 一条实测纪律
 *
 * `wait()` 的定时器**不得 unref**：调用方正在显式等待就绪，定时器必须拖住事件循环，否则
 * 得到 `Promise resolution is still pending but the event loop has already resolved`
 * （2026-10-07 实测：unref 后该用例被 runner 判为 cancelled）。「不拖住父进程」的存活性管理
 * 只适用于**空闲**的热进程句柄。
 */
export class LayaReadyWaiters {
  /** 在途等待者（就绪 / 回收 / 退出时整体兑现）。 */
  private readonly waiters: Array<(ready: boolean) => void> = [];

  /**
   * 等待一次就绪信号。
   *
   * @param timeoutMs 最长等待（毫秒）。
   * @returns 就绪为 true；超时为 false。
   */
  public wait(timeoutMs: number): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        LayaReadyWaiters.drop(this.waiters, waiter);
        resolve(false);
      }, timeoutMs);
      const waiter = (ready: boolean): void => {
        clearTimeout(timer);
        resolve(ready);
      };
      this.waiters.push(waiter);
    });
  }

  /**
   * 兑现全部等待者并清空。
   *
   * @param ready 兑现值。
   * @returns 被兑现的等待者数量。
   */
  public settle(ready: boolean): number {
    const waiters = this.waiters.splice(0);
    for (const waiter of waiters) {
      waiter(ready);
    }
    return waiters.length;
  }

  /**
   * 从等待者列表里摘掉一个（超时路径用）。
   *
   * @param waiters 等待者列表。
   * @param target 目标等待者。
   * @returns 无返回值。
   */
  private static drop(
    waiters: Array<(ready: boolean) => void>,
    target: (ready: boolean) => void,
  ): void {
    const index = waiters.indexOf(target);
    if (index >= 0) {
      waiters.splice(index, 1);
    }
  }
}
