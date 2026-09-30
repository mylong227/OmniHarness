import type { BeliefSnapshot } from './beliefSnapshot.js';
import type { BeliefUpdateReport } from './beliefUpdateReport.js';

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
