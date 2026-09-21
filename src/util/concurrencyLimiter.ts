/**
 * @beta
 * 并发闸门：限制同时运行的任务数（信号量语义，槽位直接移交等待者）。
 *
 * 构造期 fail-closed：上限必须是 ≥1 的有限数——`0 / 负数 / NaN` 会让 `acquire()`
 * 「恒不满足 `active < limit`、且永无释放者」，调用方**永久挂起**（不是报错、不是降级，
 * 是永不 settle 的黑洞）。实测：`run_workflow` 收到 `maxConcurrency: 0` 的工作流定义即
 * 永不返回（2026-09-21 探针）。故非法值一律在构造时以 RangeError 拒绝，给出可执行信息。
 */
export class ConcurrencyLimiter {
  /** 生效的并发上限（已校验为 ≥1 的整数）。 */
  private readonly limit: number;
  /** 当前活跃任务数。 */
  private active = 0;
  /** 等待槽位的挂起者队列（释放时直接移交队首）。 */
  private readonly waiters: Array<() => void> = [];

  /**
   * @param limit 并发上限（≥1 的有限数；非法即抛 RangeError，不构造会挂死的闸门）。
   */
  public constructor(limit: number) {
    this.limit = requireConcurrencyLimit(limit, 'limit');
  }

  /** 当前活跃任务数（观测用）。
   * @returns 正在执行的槽位数。
   */
  public activeCount(): number {
    return this.active;
  }

  /** 并发上限。
   * @returns 生效的并发上限（≥1 的整数）。
   */
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

  /** 在闸门约束下执行任务（异常也保证释放）。
   * @param task 受闸门约束的异步任务
   * @returns 任务结果（异常原样上抛，槽位已在 finally 释放）。
   */
  public async run<T>(task: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await task();
    } finally {
      this.release();
    }
  }
}

/**
 * 校验并发上限：有限、≥1 的整数（`Math.floor` 归一化）。
 *
 * 为什么必须在这里 fail-closed：非法上限不会「跑得慢」，而是让闸门**永不放行**——
 * `active < limit` 恒假、`release()` 又永不被调用，调用方永久挂起且无任何日志。
 * 拒绝（带可执行信息）远优于静默挂死。
 *
 * @param value 待校验的并发上限（运行时可能来自配置/CLI/模型实参，故按 unknown 收）
 * @param label 出错信息中指代该值的名称（如配置项名、工具参数名）
 * @returns 归一化后的并发上限（≥1 的整数）
 * @throws RangeError 非有限数、非数字或 < 1 时抛出（fail-closed）
 */
export function requireConcurrencyLimit(value: unknown, label = 'concurrency'): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 1) {
    throw new RangeError(
      `并发上限非法（${label}=${String(value)}）：需为 ≥1 的整数（例如 ${label}=4）`,
    );
  }
  return Math.floor(value);
}
