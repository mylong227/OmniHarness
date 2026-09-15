/**
 * 有界均衡并行映射（零依赖，实验性 @beta）。
 *
 * 生态位：把「N 个相互独立的异步任务」从串行 `for … await` 提升为**有界并发 + 均衡调度**：
 * 固定上界 `concurrency` 个在飞任务，槽位在任务完成瞬间**直接移交**下一个等待者
 * （先到先服务，无队头阻塞）——快任务不必排在慢任务之后，墙钟时间趋近
 * `总工作量 / 并发度`，从而突破单线程串行瓶颈。
 *
 * 与既有原语的关系：
 *  - 复用 {@link ConcurrencyLimiter}（信号量）限流，不重复造闸门；
 *  - 与 `ToolScheduler`（Agent 工具并行，位于热区且自带「并行安全」判定）职责不同：
 *    本类**不做并行安全判定**，由调用方保证任务间无共享可变状态。
 *
 * 语义保证（配机械测试）：
 *  1. 结果与输入**同序**（下标一一对应，调用方无需重排）；
 *  2. 在飞任务数**恒 ≤ concurrency**（下界 1；非有限值按 1 处理）；
 *  3. `concurrency = 1` 时**退化为严格串行**（与朴素 for-await 等价，零行为变更）。
 *
 * 适用：I/O 密集的独立任务（评测实例、子进程、网络请求）。
 * **不适用**：CPU 密集（Node 单线程，需 `worker_threads`）；存在共享可变状态的任务（须串行）。
 */

import { ConcurrencyLimiter } from './concurrencyLimiter.js';

/**
 * 有界均衡并行映射器。
 * 无模块级可变状态，可多实例并发使用（每个实例独立持有闸门）。
 */
export class ParallelMap {
  /** 并发闸门（复用既有限流原语；槽位完成即移交等待者）。 */
  private readonly limiter: ConcurrencyLimiter;

  /**
   * @param concurrency 并发上限（下界 1；非有限值按 1 归一化）。
   */
  public constructor(concurrency: number) {
    this.limiter = new ConcurrencyLimiter(ParallelMap.normalize(concurrency));
  }

  /**
   * 当前生效的并发上限（观测用）。
   * @returns 归一化后的并发上限。
   */
  public concurrency(): number {
    return this.limiter.limitOf();
  }

  /**
   * 有界并发、同序、均衡地映射 `items`。
   *
   * @param items 待处理元素（其顺序即结果顺序）。
   * @param fn 逐元素异步处理器（须自洽：单个元素抛错会使整体 `Promise.all` 拒绝，
   *          需要失败隔离时请在 `fn` 内部捕获）。
   * @returns 与 `items` 同序的结果数组。
   */
  public async map<T, R>(
    items: readonly T[],
    fn: (item: T, index: number) => Promise<R>,
  ): Promise<R[]> {
    return Promise.all(items.map((item, index) => this.limiter.run(() => fn(item, index))));
  }

  /**
   * 归一化并发上限：有限正整数，下界 1。
   * @param concurrency 原始并发值。
   * @returns 归一化后的并发上限。
   */
  private static normalize(concurrency: number): number {
    if (!Number.isFinite(concurrency)) {
      return 1;
    }
    return Math.max(1, Math.floor(concurrency));
  }
}
