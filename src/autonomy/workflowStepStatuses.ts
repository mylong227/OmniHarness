import type { WorkflowStepStatus } from '../ports/autonomy/workflowStepStatus.js';

/**
 * 工作流步骤终态的**判定与显示**工具（无状态）。
 *
 * 为什么在 `autonomy/` 而不在 `ports/`：端口层是契约层，架构门禁禁止其中出现实现
 * （2026-10-08 实测：带方法的类放进 `src/ports/**` 会被判「ports 纯度」违规）。
 */
export class WorkflowStepStatuses {
  /** 条件表达式（`when.status`）允许引用的终态白名单。 */
  public static readonly GUARDABLE: readonly WorkflowStepStatus[] = ['done', 'failed', 'skipped'];

  /**
   * 该终态是否使整体工作流判**成功**（设计内跳过不算失败）。
   *
   * @param status 步骤终态。
   * @returns `done` / `skipped` 为 true。
   */
  public static countsAsSuccess(status: WorkflowStepStatus): boolean {
    return status === 'done' || status === 'skipped';
  }

  /**
   * 该终态是否需要**阻断下游**（fail-closed 传播）。
   *
   * @param status 步骤终态。
   * @returns `failed` / `blocked` / `cancelled` 为 true。
   */
  public static blocksDownstream(status: WorkflowStepStatus): boolean {
    return !WorkflowStepStatuses.countsAsSuccess(status);
  }

  /**
   * 人类可读标签（工具渲染用；与终态一一对应）。
   *
   * @param status 步骤终态。
   * @returns 中文标签。
   */
  public static labelOf(status: WorkflowStepStatus): string {
    switch (status) {
      case 'done':
        return '✅ 完成';
      case 'failed':
        return '❌ 失败';
      case 'skipped':
        return '⏭️ 条件未满足（设计内跳过）';
      case 'blocked':
        return '🚫 被上游阻塞';
      case 'cancelled':
        return '⛔ 已取消';
    }
  }
}
