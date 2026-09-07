/** 审批规则决定。 */
export type ApprovalRuleDecision = 'allow' | 'deny' | 'ask';

/** 审批规则：工具级 + 命令前缀过滤。 */
export interface ApprovalRule {
  readonly toolName?: string;
  readonly commandPrefix?: string;
  readonly decision: ApprovalRuleDecision;
}
