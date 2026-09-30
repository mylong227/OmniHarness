/** 信念快照：对角高斯近似（均值 + 对角方差 + 置信摘要）。 */
export interface BeliefSnapshot {
  /** 均值向量 μ。 */
  readonly mean: readonly number[];
  /** 对角方差向量 σ²（每维独立，免矩阵求逆）。 */
  readonly variance: readonly number[];
  /** 置信摘要 0..1（如有效样本比 / 归一化集中度）。 */
  readonly confidence: number;
}
