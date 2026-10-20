/**
 * token 估算校准器（CTX-02，2026-10-20）。
 *
 * 不引真 tokenizer（会破坏“运行时极简”），而是把**已观测的估算值 vs 端点实际值**收进来，
 * 产出 median/p90 误差与建议系数。调用方可用它决定是否收紧压缩阈值。
 */
export interface CalibrationSample {
  /** 本地估算 token。 */
  readonly estimated: number;
  /** 端点实际 token。 */
  readonly actual: number;
}

/** 校准报告。 */
export interface CalibrationReport {
  readonly samples: number;
  /** 相对误差中位数（`|est-actual|/actual`）。 */
  readonly medianErrorPct: number;
  /** 相对误差 p90。 */
  readonly p90ErrorPct: number;
  /** 建议系数（actual/estimated 的中位数；样本不足时为 1）。 */
  readonly factor: number;
}

/** token 估算校准器（有界样本，避免长进程无界增长）。 */
export class TokenEstimatorCalibrator {
  /** 有界样本环（超出 limit 丢最旧）。 */
  private readonly samples: CalibrationSample[] = [];

  /**
   * @param limit 保留样本上限（默认 512，超出丢最旧）。
   */
  public constructor(private readonly limit = 512) {}

  /**
   * 记录一条样本（actual<=0 或非有限值直接忽略，不参与校准）。
   * @param sample 估算/实际。
   * @returns 无返回值。
   */
  public observe(sample: CalibrationSample): void {
    if (
      !Number.isFinite(sample.estimated) ||
      !Number.isFinite(sample.actual) ||
      sample.estimated <= 0 ||
      sample.actual <= 0
    ) {
      return;
    }
    this.samples.push(sample);
    if (this.samples.length > this.limit) this.samples.shift();
  }

  /**
   * 生成报告。
   * @returns 样本数、median/p90 相对误差与建议系数。
   */
  public report(): CalibrationReport {
    if (this.samples.length === 0) {
      return { samples: 0, medianErrorPct: 0, p90ErrorPct: 0, factor: 1 };
    }
    const errors = this.samples
      .map((sample) => Math.abs(sample.estimated - sample.actual) / sample.actual)
      .sort((a, b) => a - b);
    const factors = this.samples
      .map((sample) => sample.actual / sample.estimated)
      .sort((a, b) => a - b);
    return {
      samples: this.samples.length,
      medianErrorPct: TokenEstimatorCalibrator.percentile(errors, 0.5) * 100,
      p90ErrorPct: TokenEstimatorCalibrator.percentile(errors, 0.9) * 100,
      factor: TokenEstimatorCalibrator.percentile(factors, 0.5),
    };
  }

  /**
   * 压缩阈值修正比例（`1/factor`，夹在 [0.67, 1.5]；样本不足/非法值为 1）。
   *
   * 放在校准器而不是压缩器里：这是「校准结果怎么用」的唯一口径，
   * 换一个消费点（例如容量面板告警）不应再抄一遍夹紧逻辑。
   * @param minSamples 最少样本数（默认 5）。
   * @returns 阈值乘数（约 0.67–1.5）。
   */
  public thresholdRatio(minSamples = 5): number {
    const report = this.report();
    if (report.samples < minSamples) return 1;
    const factor = report.factor;
    if (!Number.isFinite(factor) || factor <= 0) return 1;
    return 1 / Math.min(1.5, Math.max(0.67, factor));
  }

  /**
   * 取分位数（线性插值；空数组返回 0）。
   * @param sorted 已排序数组。
   * @param q 0..1。
   * @returns 分位值。
   */
  private static percentile(sorted: readonly number[], q: number): number {
    if (sorted.length === 0) return 0;
    const index = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * q)));
    return sorted[index] ?? 0;
  }
}
