import type { PolicyEffect } from './policyEffect.js';

/**
 * @beta
 * 单条策略规则。
 */
export interface PolicyRule {
  /** 规则名（用于审计/可读）。 */
  readonly name: string;
  /** 触发条件：安全布尔表达式字符串（空字符串 = 恒真，即兜底规则）。 */
  readonly when: string;
  /** 命中时的效应。 */
  readonly effect: PolicyEffect;
}
