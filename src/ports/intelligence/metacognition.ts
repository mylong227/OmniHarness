/**
 * 元认知信念端口（MetacognitionPort，P2 · 信念支柱）。
 *
 * 把"信念"建模为统计流形上的分布，提供两类可审计更新：
 * - `naturalStep`：自然梯度（信息几何）——沿逆 Fisher 度规（此处=逆对角协方差）预处理梯度后步进；
 * - `correct`：观测修正（贝叶斯 / 粒子滤波）——给定观测与噪声，更新信念。
 *
 * 每次更新返回 **可审计 KL 分解**：本次更新在信念流形上引起的 KL 散度被拆成可命名分量
 * （均值漂移 / 方差变化 / 逐维明细），并附 **重参数化不变性审计**（维度排列下总 KL 与分解一致，
 * 坐标图无关——信息几何铁律）。零运行时依赖。
 */

/** 信念快照：对角高斯近似（均值 + 对角方差 + 置信摘要）。 */
export interface BeliefSnapshot {
  /** 均值向量 μ。 */
  readonly mean: readonly number[];
  /** 对角方差向量 σ²（每维独立，免矩阵求逆）。 */
  readonly variance: readonly number[];
  /** 置信摘要 0..1（如有效样本比 / 归一化集中度）。 */
  readonly confidence: number;
}

/** KL 分解的逐维分量。 */
export interface BeliefKlComponent {
  /** 维度下标。 */
  readonly dim: number;
  /** 该维"均值漂移"引起的 KL 分量。 */
  readonly meanShift: number;
  /** 该维"方差变化"引起的 KL 分量。 */
  readonly variance: number;
  /** 该维 KL 总量（= meanShift + variance）。 */
  readonly total: number;
}

/** 一次信念更新的可审计报告。 */
export interface BeliefUpdateReport {
  /** 更新前快照。 */
  readonly before: BeliefSnapshot;
  /** 更新后快照。 */
  readonly after: BeliefSnapshot;
  /** 可审计 KL 分解（KL(after ‖ before)，信息几何）：总量 + 命名分量 + 逐维明细。 */
  readonly kl: {
    /** KL 总量。 */
    readonly total: number;
    /** 纯均值漂移分量之和。 */
    readonly meanShift: number;
    /** 纯方差变化分量之和。 */
    readonly variance: number;
    /** 逐维明细（顺序与维度一致）。 */
    readonly perDimension: ReadonlyArray<BeliefKlComponent>;
  };
  /**
   * 重参数化不变性审计：把信念维度排列后重算总 KL，应与原总 KL 一致（坐标图无关）。
   * 信息几何铁律——KL 是流形上的标量，不依赖维度排序这一坐标表示。
   */
  readonly reparamInvariant: boolean;
}

/** 元认知信念端口（P2 · I-P2-2 自然梯度信念 / I-P2-3 粒子滤波信念 共用）。 */
export interface MetacognitionPort {
  /** 当前信念快照。 */
  snapshot(): BeliefSnapshot;
  /**
   * 自然梯度（信息几何）步进：梯度向量 `gradient` 沿逆 Fisher 度规（逆对角协方差）预处理后更新均值。
   * 返回可审计 KL 分解报告。
   */
  naturalStep(gradient: readonly number[], learningRate?: number): BeliefUpdateReport;
  /**
   * 观测修正（贝叶斯 / 粒子滤波）：给定观测向量与观测噪声，更新信念。
   * 返回可审计 KL 分解报告。
   */
  correct(observation: readonly number[], observationNoise?: number): BeliefUpdateReport;
}
