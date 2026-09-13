/**
 * 相变固化端口（P2, I-P2-5）。
 *
 * 微观粒子/对称破缺隐喻（Higgs 相变）：以"经验密度"为序参量，当某个技能组合的
 * 使用密度越过临界阈值，该"常用组合"便冻结成一条稳定的原生能力（一次组合、永久可用，
 * 不再每次临时重新组合）。冻结是**加法式**——只新增原生能力，绝不删改源组合或既有能力
 * （fail-closed）。
 */
import type { Skill } from '../../skill/skill.js';

/** 已冻结（相变固化）的原生能力。 */
export interface FrozenCapability {
  /** 冻结后注册的原生技能名（形如 __crystal_<hash> 或由组合派生的稳定名）。 */
  readonly name: string;
  /** 来源技能组合（按序参量观测时的顺序或排序后的组合键）。 */
  readonly from: readonly string[];
  /** 触发冻结时的经验密度。 */
  readonly density: number;
}

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

/** 相变固化器端口（接 SkillPort，把常用组合冻结为原生能力）。 */
export interface CapabilityCrystallizerPort {
  /** 观测一次组合使用：经验密度累加（序参量抬升）。 */
  observe(combination: readonly string[]): void;
  /** 当前经验密度（序参量取值）。 */
  density(combination: readonly string[]): number;
  /** 越阈冻结：遍历密度越界的组合，冻结为原生能力；返回本轮报告。 */
  crystallize(): CrystallizationReport;
  /** 已冻结能力清单。 */
  frozen(): readonly FrozenCapability[];
}
