import type { PolicyEffect } from './policyEffect.js';

/**
 * @beta
 * 求值结果。
 */
export interface PolicyDecision {
  /** 最终效应。 */
  readonly effect: PolicyEffect;
  /** 命中的规则名（无命中则为 null）。 */
  readonly matchedRule: string | null;
  /** 求值中的告警（如某规则表达式解析失败，fail-closed 跳过该规则）。 */
  readonly warnings: readonly string[];
}
