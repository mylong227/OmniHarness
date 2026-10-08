export type { WorkflowStep } from '../ports/autonomy/workflowStep.js';
export type { WorkflowStepGuard } from '../ports/autonomy/workflowStepGuard.js';
export type { WorkflowDef } from '../ports/autonomy/workflowDef.js';
export { WorkflowStepStatuses } from './workflowStepStatuses.js';
export type { WorkflowStepStatus } from '../ports/autonomy/workflowStepStatus.js';

import type { WorkflowStepStatus } from '../ports/autonomy/workflowStepStatus.js';

/**
 * @beta
 * 单步结果。
 */
export interface WorkflowStepResult {
  readonly id: string;
  /** 是否成功（仅 `status === 'done'` 为 true；条件跳过见 `status`）。 */
  readonly ok: boolean;
  /**
   * 步骤**终态**（2026-10-08 增补：区分「设计内跳过」与「被上游拖死」）。
   *
   * `skipped` 是作者写下的正常分支结果（不阻断下游、不使整体失败）；
   * `blocked` / `cancelled` 是故障传播（阻断下游、整体判失败）。
   * 只看 `ok` 无法区分这两种，而它们的事后处置完全相反。
   */
  readonly status: WorkflowStepStatus;
  /** 成功时的产出文本。 */
  readonly output?: string | undefined;
  /** 失败 / 跳过原因。 */
  readonly error?: string | undefined;
  /** 子智能体步数。 */
  readonly steps: number;
  /** 耗时（毫秒）。 */
  readonly durationMs: number;
  /**
   * 该步是否**因步数耗尽而截断**（2026-10-01 审计补）。
   *
   * 存在理由：`Agent.resultOf` 专门透出 `truncated`/`aborted`，就是为了让调用方不要把
   * 「跑满预算」读成「任务完成」。`SubagentTool.render` 已按此标注，而工作流步骤原先无条件
   * `ok: true` —— 于是步数耗尽后返回的兜底摘要会被当成真实产出，沿 DAG 注入下游 prompt。
   */
  readonly truncated?: boolean | undefined;
  /** 该步是否被失控熔断 / 取消（同 `truncated`，不可读成完成）。 */
  readonly aborted?: boolean | undefined;
}

/**
 * @beta
 * 工作流整体结果。
 */
export interface WorkflowResult {
  /** 是否全部步骤成功或**设计内跳过**（`blocked`/`cancelled`/`failed` 一律为 false）。 */
  readonly ok: boolean;
  /** 各步结果（拓扑序）。 */
  readonly steps: readonly WorkflowStepResult[];
  /** 成功步骤的输出（id → output），供后续消费。 */
  readonly blackboard: Readonly<Record<string, string>>;
  /** 本次运行 id（`persist` 开启时可用它 `resume` 续跑）。 */
  readonly runId: string;
  /** 续跑时**复用产出**（未重跑）的步骤 id 列表。 */
  readonly resumed: readonly string[];
}
