import type { CrystallizationReport } from './crystallizationReport.js';
import type { FrozenCapability } from './frozenCapability.js';

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
