/**
 * @beta
 * 计划的一步。
 */
export interface PlanStep {
  /** 这一步要做什么。 */
  readonly description: string;
  /** 完成情况（可选，呈现后回填）。 */
  readonly status?: 'pending' | 'done' | undefined;
}
