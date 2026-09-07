/**
 * @beta
 * 计划端口（对标 DeepSeek `packages/plan/plan-mode`）。
 *
 * 计划协作态：agent 进入计划态 → 探索 → 写计划（`write`）→ 呈现等审批
 * （`present` + `decide`）。`PlanProjection{active, pending}` 即由这套生命周期折叠而来。
 */
export type PlanStatus = 'drafting' | 'presented' | 'approved' | 'rejected';

/**
 * @beta
 * 计划的一步。
 */
export interface PlanStep {
  /** 这一步要做什么。 */
  readonly description: string;
  /** 完成情况（可选，呈现后回填）。 */
  readonly status?: 'pending' | 'done';
}

/**
 * @beta
 * 计划草稿（模型写入的内容）。
 */
export interface PlanDraft {
  /** 计划标题（可选）。 */
  readonly title?: string;
  /** 有序步骤。 */
  readonly steps: readonly PlanStep[];
}

/**
 * @beta
 * 计划当前态（含生命周期状态）。
 */
export interface PlanState extends PlanDraft {
  readonly status: PlanStatus;
  /** 呈现时刻（present 后写入）。 */
  readonly presentedAt?: string;
}

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
