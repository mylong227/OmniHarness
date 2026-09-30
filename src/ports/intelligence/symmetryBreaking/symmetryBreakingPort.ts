import type { UsageSample } from './usageSample.js';
import type { SymmetryBreakReport } from './symmetryBreakReport.js';

/** 对称破缺端口。 */
export interface SymmetryBreakingPort {
  readonly name: string;
  /**
   * 观测一次使用样本，推进序参量 ρ。
   * 返回本次是否发生相变（对称→破缺）。fail-closed：空样本不推进、不抛错。
   */
  observe(usage: readonly UsageSample[]): boolean;
  /** 当前对称态快照（能力相变可观测）。 */
  snapshot(): SymmetryBreakReport;
  /** 重置序参量，回到对称态。 */
  reset(): void;
}
