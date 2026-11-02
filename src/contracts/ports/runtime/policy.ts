/**
 * 安全策略求值端口（#S34，「策略规则 → 决策」的安全子集）。
 *
 * 不搬完整 Starlark 解释器（那是一个完整 Python 方言、需全语言解释器，违反无第三方依赖铁律且过重）。
 * 只搬其**可移植内核**：用一组「事实(facts) + 规则(rules: 安全布尔表达式 → allow/deny/ask)」
 * 驱动沙箱/审批决策。求值器为纯递归下降解析、零代码执行（绝无 eval/Function），fail-closed。
 *
 * 事实值类型：string | number | boolean | string[]。表达式运算符：== != ~（正则） in（成员/子串）
 * 以及 and / or / not / 括号。规则按顺序匹配，首条命中即生效；无命中则用默认决策（默认 ask，保守）。
 *
 * 本文件已退化为桶：5 个接口各自独立成文件于 `./policy/`，调用点零改动。
 */

export type { PolicyEffect } from './policy/policyEffect.ts';
export type { PolicyFacts } from './policy/policyFacts.ts';
export type { PolicyRule } from './policy/policyRule.ts';
export type { PolicyDecision } from './policy/policyDecision.ts';
export type { PolicyPort } from './policy/policyPort.ts';
