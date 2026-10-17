/**
 * 计划端口（对标 DeepSeek `packages/plan/plan-mode`）。
 *
 * 计划协作态：agent 进入计划态 → 探索 → 写计划（`write`）→ 呈现等审批
 * （`present` + `decide`）。`PlanProjection{active, pending}` 即由这套生命周期折叠而来。
 *
 * 本文件已退化为桶：5 个接口各自独立成文件于 `./plan/`，调用点零改动。
 */

export type { PlanStatus } from './plan/planStatus.ts';
export type { PlanStep } from './plan/planStep.ts';
export type { PlanDraft } from './plan/planDraft.ts';
export type { PlanState } from './plan/planState.ts';
export type { PlanPort } from './plan/planPort.ts';
