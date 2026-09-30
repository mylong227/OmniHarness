import type { PlanDraft } from './planDraft.js';
import type { PlanStatus } from './planStatus.js';

/**
 * @beta
 * 计划当前态（含生命周期状态）。
 */
export interface PlanState extends PlanDraft {
  readonly status: PlanStatus;
  /** 呈现时刻（present 后写入）。 */
  readonly presentedAt?: string | undefined;
}
