/**
 * Agent Workflow Memory 端口（P4）。
 *
 * 与技能库区分：技能是「可复用的能力单元」；workflow memory 是「某类任务上一次成功走完的
 * 工具序列」。它只提供**参考轨迹**，不自动重放（工具副作用与参数不可无条件复用）。
 */

/** 一条成功 workflow。 */
export interface WorkflowMemoryEntry {
  /** 稳定 id。 */
  readonly id: string;
  /** 任务描述（模型/用户原文，已裁剪）。 */
  readonly task: string;
  /** 工具步骤（如 `apply_patch`、`shell`；只存名称/摘要，不存全量输出）。 */
  readonly steps: readonly string[];
  /** 记录时间（ISO）。 */
  readonly at: string;
}

/** Workflow memory 端口。 */
export interface WorkflowMemoryPort {
  /**
   * 记录一条成功 workflow（同 task + steps 去重）。
   * @param task 任务描述
   * @param steps 工具步骤
   * @returns 无返回值
   */
  remember(task: string, steps: readonly string[]): Promise<void>;

  /**
   * 按任务词重叠召回相似 workflow。
   * @param task 当前任务
   * @param limit 最多条数
   * @returns 最近的相似条目
   */
  recall(task: string, limit?: number): Promise<readonly WorkflowMemoryEntry[]>;
}
