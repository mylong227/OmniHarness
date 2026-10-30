import type { ApprovalRule } from './approvalRule.ts';
import { TOOL_NAMES } from '../../ports/tool/toolNames.ts';

/**
 * 内置基线审批规则（默认档 rules 的最小危险命令拦截集）——**单一真源**。
 *
 * 两处消费者必须共用本表，禁止各抄一份：
 *  1. `cliBuildConfig.buildRuleApproval`（启动路径：serve / CLI 的 rules 档端口）；
 *  2. `appServerState.RULES_DEFAULT`（UI 切到默认档时，配置端口不是 rules 的回退实现）。
 *
 * 历史教训：回退实现曾是一份无条件 allow 的端口，与启动路径的真实 rules 端口语义漂移——
 * 用户在 UI 点「默认」后 rm/del 拦截悄然消失（沙箱层兜底仍在，但审批层语义已不成立）。
 */
export const BUILTIN_APPROVAL_RULES: readonly ApprovalRule[] = [
  { toolName: TOOL_NAMES.readFile, decision: 'allow' },
  { toolName: TOOL_NAMES.shell, commandPrefix: 'rm ', decision: 'deny' },
  { toolName: TOOL_NAMES.shell, commandPrefix: 'del ', decision: 'deny' },
];
