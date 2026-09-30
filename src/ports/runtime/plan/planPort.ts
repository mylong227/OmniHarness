import type { PlanDraft } from './planDraft.js';
import type { PlanState } from './planState.js';

/**
 * @beta
 * 计划端口：会话级计划态的统一插口。
 */
export interface PlanPort {
  readonly name: string;
  /** 写入/更新计划草稿（重新起草会回到 drafting，需再次呈现审批）。 */
  write(draft: PlanDraft): void;
  /** 标记计划已呈现给用户（等待审批）。 */
  present(): void;
  /** 记录审批结论。 */
  decide(decision: 'approve' | 'reject'): void;
  /** 取当前计划态（未写计划前为 null）。 */
  get(): PlanState | null;
}
