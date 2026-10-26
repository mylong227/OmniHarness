/**
 * 流式分位数草图（Greenwald–Khanna，GK sketch）。
 *
 * ## 为什么不用「保存全部样本再排序」
 *
 * 长运行服务会产生几十万次回合/工具调用。保存全部样本再排序是 O(n) 内存 + O(n log n)，
 * 而观测只需要 p50/p95/p99。GK 草图用 **O(1/ε · log(εn))** 个有序元组，给出确定性误差界：
 * 对任意分位数 q，返回值的真实秩误差 ≤ ε·n。
 *
 * ## 数据不变式
 *
 * 元组 `(v, g, Δ)`：
 * - `g` = 该元组覆盖的秩区间下界（gaps）；
 * - `Δ` = 该元组能吸收的最大误差（上界差）；
 * - 压缩条件：`g_i + g_{i+1} + Δ_{i+1} ≤ ⌊2εn⌋` 时合并相邻元组。
 *
 * @maturity L2 — 真实 GK 插入/压缩/查询；未做多草图 merge 与加权样本
 * @maturityEvidence tests/unit/quantileSketch.test.ts
 */

/** 一个有序元组。 */
interface QuantileTuple {
  /** 值。 */
  readonly v: number;
  /** 秩下界跨度。 */
  g: number;
  /** 误差上界。 */
  readonly delta: number;
}

/** Greenwald–Khanna 分位数草图。 */
export class QuantileSketch {
  /** 有序元组（按 v 升序）。 */
  private readonly tuples: QuantileTuple[] = [];
  /** 样本总数。 */
  private count = 0;
  /** 目标相对误差（0,1）。 */
  private readonly epsilon: number;

  /**
   * @param epsilon 相对误差（缺省 0.01 = 1%）。
   */
  public constructor(epsilon = 0.01) {
    if (!(epsilon > 0 && epsilon < 1)) throw new Error('epsilon 必须在 (0,1)');
    this.epsilon = epsilon;
  }

  /**
   * 插入一个样本。
   * @param value 样本值（非有限值忽略）。
   * @returns 无返回值。
   */
  public insert(value: number): void {
    if (!Number.isFinite(value)) return;
    this.count += 1;
    const index = this.lowerBound(value);
    if (index < this.tuples.length && this.tuples[index]?.v === value) {
      this.tuples[index]!.g += 1;
    } else {
      const delta =
        index === 0 || index === this.tuples.length ? 0 : Math.floor(2 * this.epsilon * this.count);
      this.tuples.splice(index, 0, { v: value, g: 1, delta });
    }
    this.compress();
  }

  /**
   * 查询分位数（0..1）。
   * @param q 分位数（0 = 最小，1 = 最大）。
   * @returns 近似分位数；无样本时为 NaN。
   */
  public quantile(q: number): number {
    if (this.count === 0) return Number.NaN;
    const clamped = Math.min(1, Math.max(0, q));
    const rank = Math.max(1, Math.ceil(clamped * this.count));
    let cumulative = 0;
    for (const tuple of this.tuples) {
      cumulative += tuple.g;
      if (cumulative + tuple.delta >= rank) return tuple.v;
    }
    return this.tuples[this.tuples.length - 1]?.v ?? Number.NaN;
  }

  /**
   * 当前样本数。
   * @returns 样本数。
   */
  public size(): number {
    return this.count;
  }

  /**
   * 草图元组数（内存上界观测）。
   * @returns 元组数。
   */
  public centroidCount(): number {
    return this.tuples.length;
  }

  /**
   * 清空。
   * @returns 无返回值。
   */
  public clear(): void {
    this.tuples.length = 0;
    this.count = 0;
  }

  /**
   * 第一个 ≥ value 的下标。
   * @param value 值。
   * @returns 下标。
   */
  private lowerBound(value: number): number {
    let low = 0;
    let high = this.tuples.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if ((this.tuples[mid]?.v ?? Number.POSITIVE_INFINITY) < value) low = mid + 1;
      else high = mid;
    }
    return low;
  }

  /**
   * 压缩相邻元组，维持误差界。
   * @returns 无返回值。
   */
  private compress(): void {
    const threshold = Math.floor(2 * this.epsilon * this.count);
    // 保留最后一个元组：合并它会把最大值吞掉（max 是观测面，不能被误差界牺牲）。
    let index = this.tuples.length - 3;
    while (index >= 0) {
      const left = this.tuples[index];
      const right = this.tuples[index + 1];
      if (
        left !== undefined &&
        right !== undefined &&
        left.g + right.g + right.delta <= threshold
      ) {
        left.g += right.g;
        this.tuples.splice(index + 1, 1);
      }
      index -= 1;
    }
  }
}
