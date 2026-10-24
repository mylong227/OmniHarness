/**
 * @beta
 * 计划端口（计划态由运行时投影，批准前写类工具被门禁拦截）。
 *
 * 计划协作态：agent 进入计划态 → 探索 → 写计划（`write`）→ 呈现等审批
 * （`present` + `decide`）。`PlanProjection{active, pending}` 即由这套生命周期折叠而来。
 */
export type PlanStatus = 'drafting' | 'presented' | 'approved' | 'rejected';
