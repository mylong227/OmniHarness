/** 审批规则决定。 */
export type ApprovalRuleDecision = 'allow' | 'deny' | 'ask';

/** 审批规则：工具级 + 命令约束（前缀或 glob）。 */
export interface ApprovalRule {
  /** 限定工具名（未声明则不限制工具）。 */
  readonly toolName?: string | undefined;
  /** 命令前缀约束（`startsWith` 匹配）。 */
  readonly commandPrefix?: string | undefined;
  /**
   * 命令 glob 约束（`*` 任意串 / `?` 单字符，整串匹配）。
   * 与 `commandPrefix` 同为可选命令约束：二者同时给出时须**同时满足**（合取），
   * 便于「限定子命令族 + 约束参数」的组合规则。
   */
  readonly commandGlob?: string | undefined;
  /** 命中后的裁决。 */
  readonly decision: ApprovalRuleDecision;
}
