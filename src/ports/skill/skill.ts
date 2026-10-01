import type { MoireMeta } from './moireMeta.js';

/**
 * @beta
 * 技能：声明式能力包，命中时注入上下文指导模型行为（SKILL.md 思路）。
 *
 * `capabilityField` 与 `moire` 为可选扩展：莫尔组合算子（燧-1）使用它们刻画
 * 并承载「两技能都没有的涌现长波能力」。无此字段的旧技能完全向后兼容。
 */
export interface Skill {
  readonly name: string;
  readonly description: string;
  readonly instructions: string;
  readonly tags?: readonly string[];
  /**
   * 可选能力场（扁平 N*N 的二维正弦光栅，值 ∈ [-1,1]）。
   * 缺省时由组合器按技能文本确定性派生（可复现、非随机）。
   */
  readonly capabilityField?: readonly number[];
  /** 若本技能由莫尔组合而来，记录来源/转角/涌现强度。 */
  readonly moire?: MoireMeta;
  /**
   * 若本技能由相变固化（I-P2-5）冻结而来：标记为真，并记录来源组合。
   * 可选字段，向后兼容——旧技能不携带。
   */
  readonly frozen?: boolean;
  /** 相变固化来源组合（frozen=true 时非空）。 */
  readonly frozenFrom?: readonly string[];
}
