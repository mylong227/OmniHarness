/** 一轮相变固化报告。 */
export interface CrystallizationReport {
  /** 临界阈值（越过即冻结）。 */
  readonly threshold: number;
  /** 本轮新冻结的能力名清单。 */
  readonly frozen: readonly string[];
  /** 因已冻结而跳过的 combo 数（聚合进单一原生能力，不重复冻结）。 */
  readonly alreadyFrozen: number;
  /** 因名称冲突/组合失败而跳过的 combo 键。 */
  readonly skipped: readonly string[];
  /** 本轮各冻结组合经 composeByTwist 产出的真实涌现强度（峰值），用于收紧闭环评估。 */
  readonly emergences: readonly number[];
  /** 因涌现低于接纳下限（emergenceFloor）被拒收、未冻结的 combo 数。 */
  readonly rejectedByFloor: number;
}
