import type { WorkflowStepGuard } from './workflowStepGuard.js';

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
  /**
   * 可选：受控执行条件（`when`）——「仅当某已依赖步骤处于某终态时才执行本步」。
   *
   * 语义与硬约束见 {@link WorkflowStepGuard}：**不改拓扑**（仍是静态 DAG），只决定本步是否执行；
   * 条件不满足记为 `skipped`（设计内跳过，**不阻断下游**），与「被上游拖死」的 `blocked` 严格区分。
   *
   * 典型用法：`{ id:'fix', dependsOn:['test'], when:{ step:'test', status:'failed' } }`（失败才补救）。
   */
  readonly when?: WorkflowStepGuard | undefined;
  /**
   * 可选：本步的**写集声明**（作者契约：这一步会写哪些路径；目录写法用路径前缀表达）。
   *
   * 语义见 `WorkflowLayerPolicy.shouldSerialize`（G2 收尾，2026-10-04 第三十轮）：同层的多个
   * "可能写"步骤，只有当**每个写者都给出知情声明**（`tools` 显式约束 + 本字段已声明）且声明集
   * **两两不相交**时才保持并发；任一条件不满足 ⇒ 整层保守串行。声明是作者的承诺（与 `tools`
   * 白名单同一信任模型——策略只对已声明的集合做确定性裁决，不校验运行期是否越界）。
   */
  readonly writes?: readonly string[];
}
