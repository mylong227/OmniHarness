/**
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
