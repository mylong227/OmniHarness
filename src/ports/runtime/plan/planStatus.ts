/**
 * @beta
 * 计划端口（对标 DeepSeek `packages/plan/plan-mode`）。
 *
 * 计划协作态：agent 进入计划态 → 探索 → 写计划（`write`）→ 呈现等审批
 * （`present` + `decide`）。`PlanProjection{active, pending}` 即由这套生命周期折叠而来。
 */
export type PlanStatus = 'drafting' | 'presented' | 'approved' | 'rejected';
