/** 已冻结（相变固化）的原生能力。 */
export interface FrozenCapability {
  /** 冻结后注册的原生技能名（形如 __crystal_<hash> 或由组合派生的稳定名）。 */
  readonly name: string;
  /** 来源技能组合（按序参量观测时的顺序或排序后的组合键）。 */
  readonly from: readonly string[];
  /** 触发冻结时的经验密度。 */
  readonly density: number;
}
