import type { SymmetryState } from './symmetryState.js';

/** 对称破缺快照报告（能力相变可观测）。 */
export interface SymmetryBreakReport {
  /** 序参量 ρ（占优能力的归一化主导度 0..1）。 */
  readonly orderParameter: number;
  /** 当前对称态。 */
  readonly state: SymmetryState;
  /** 破缺后占优的能力标识（对称态为 undefined）。 */
  readonly brokenState?: string | undefined;
  /** 被破缺的对称群标签。 */
  readonly symmetryGroup: string;
  /** 本次 observe 是否跨越阈值（发生相变）。 */
  readonly transitioned: boolean;
}
