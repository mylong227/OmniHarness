import type { PlanStep } from './planStep.js';

/**
 * @beta
 * 计划草稿（模型写入的内容）。
 */
export interface PlanDraft {
  /** 计划标题（可选）。 */
  readonly title?: string | undefined;
  /** 有序步骤。 */
  readonly steps: readonly PlanStep[];
}
