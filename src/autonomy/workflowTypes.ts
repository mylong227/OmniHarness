/**
 * @beta
 * 工作流单步定义（DAG 节点）。
 */
export interface WorkflowStep {
  /** 步骤唯一 ID（blackboard 键名）。 */
  readonly id: string;
  /** 该步的提示词。 */
  readonly prompt: string;
  /** 依赖的步骤 ID（需先完成，其输出注入本步 prompt）。 */
  readonly dependsOn?: readonly string[];
  /** 可选：授权给该步子智能体的工具白名单；不传则继承除 run_workflow/run_goal/subagent 外的全部工具。 */
  readonly tools?: readonly string[];
}

/**
 * @beta
 * 工作流定义（DAG）。
 */
export interface WorkflowDef {
  readonly name?: string;
  /** 有向无环图的节点。 */
  readonly steps: readonly WorkflowStep[];
  /** 同层最大并发步数（默认 4）。 */
  readonly maxConcurrency?: number;
}

/**
 * @beta
 * 单步结果。
 */
export interface WorkflowStepResult {
  readonly id: string;
  /** 是否成功（失败或依赖失败均为 false）。 */
  readonly ok: boolean;
  /** 成功时的产出文本。 */
  readonly output?: string;
  /** 失败 / 跳过原因。 */
  readonly error?: string;
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
