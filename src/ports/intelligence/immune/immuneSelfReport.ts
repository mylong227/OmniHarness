import type { AnomalyAlert } from './anomalyAlert.js';

/** 免疫自检报告。 */
export interface ImmuneSelfReport {
  /** 自体模型训练样本数。 */
  readonly selfSize: number;
  /** 最近一次观测到的异常（无则 null）。 */
  readonly lastAnomaly: AnomalyAlert | null;
}
