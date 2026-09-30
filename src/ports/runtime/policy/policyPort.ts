import type { PolicyRule } from './policyRule.js';
import type { PolicyFacts } from './policyFacts.js';
import type { PolicyEffect } from './policyEffect.js';
import type { PolicyDecision } from './policyDecision.js';

/**
 * @beta
 * 策略求值端口。
 */
export interface PolicyPort {
  /** 对给定事实求值整个规则集（按序，首命中生效，无命中用默认决策）。 */
  evaluate(
    rules: readonly PolicyRule[],
    facts: PolicyFacts,
    defaultEffect?: PolicyEffect,
  ): PolicyDecision;
  /** 单独求值一条表达式（供工具/调试），解析失败返回 false（fail-closed）。 */
  test(expression: string, facts: PolicyFacts): boolean;
}
