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
  /** 是否全部步骤成功。 */
  readonly ok: boolean;
  /** 各步结果（拓扑序）。 */
  readonly steps: readonly WorkflowStepResult[];
  /** 成功步骤的输出（id → output），供后续消费。 */
  readonly blackboard: Readonly<Record<string, string>>;
}
