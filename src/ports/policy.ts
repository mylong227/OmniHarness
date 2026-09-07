/**
 * 安全策略求值端口（#S34，对标 codex-rs/execpolicy 的「策略规则 → 决策」核心意图）。
 *
 * 不搬完整 Starlark 解释器（那是一个完整 Python 方言、需全语言解释器，违反零依赖铁律且过重）。
 * 只搬其**可移植内核**：用一组「事实(facts) + 规则(rules: 安全布尔表达式 → allow/deny/ask)」
 * 驱动沙箱/审批决策。求值器为纯递归下降解析、零代码执行（绝无 eval/Function），fail-closed。
 *
 * 事实值类型：string | number | boolean | string[]。表达式运算符：== != ~（正则） in（成员/子串）
 * 以及 and / or / not / 括号。规则按顺序匹配，首条命中即生效；无命中则用默认决策（默认 ask，保守）。
 */

/**
 * @beta
 * 策略决策效应。
 */
export type PolicyEffect = 'allow' | 'deny' | 'ask';

/**
 * @beta
 * 事实表：标识符 → 值。
 */
export type PolicyFacts = Readonly<Record<string, string | number | boolean | readonly string[]>>;

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
