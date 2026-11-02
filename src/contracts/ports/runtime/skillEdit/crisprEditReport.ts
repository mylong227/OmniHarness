/** CRISPR 单次编辑报告（可审计）。 */
export interface CrisprEditReport {
  /** 是否真正提交（patch 通过差异测试并写回端口）。 */
  readonly applied: boolean;
  /** 命中的技能名（语义寻址时为最相似者）。 */
  readonly skillName?: string;
  /** 是否经语义寻址命中（而非精确名）。 */
  readonly semanticAddress: boolean;
  /** 是否因差异测试失败而回滚（fail-closed，绝不提交破损编辑）。 */
  readonly rolledBack: boolean;
  /** 失败/跳过原因：no-skill-matched | no-op | differential-test-failed。 */
  readonly reason?: string;
}
