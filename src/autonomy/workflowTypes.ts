export type { WorkflowStep } from '../ports/autonomy/workflowStep.js';
export type { WorkflowDef } from '../ports/autonomy/workflowDef.js';

/**
 * @beta
 * 单步结果。
 */
export interface WorkflowStepResult {
  readonly id: string;
  /** 是否成功（失败或依赖失败均为 false）。 */
  readonly ok: boolean;
  /** 成功时的产出文本。 */
  readonly output?: string | undefined;
  /** 失败 / 跳过原因。 */
  readonly error?: string | undefined;
  /** 子智能体步数。 */
  readonly steps: number;
  /** 耗时（毫秒）。 */
  readonly durationMs: number;
}

/**
 * @beta
 * 工作流整体结果。
 */
export interface WorkflowResult {
  /** 是否全部步骤成功。 */
  readonly ok: boolean;
  /** 各步结果（拓扑序）。 */
  readonly steps: readonly WorkflowStepResult[];
  /** 成功步骤的输出（id → output），供后续消费。 */
  readonly blackboard: Readonly<Record<string, string>>;
}
