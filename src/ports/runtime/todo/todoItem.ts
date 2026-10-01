import type { TodoStatus } from './todoStatus.js';

/**
 * @beta
 * 一条待办项。
 */
export interface TodoItem {
  /** 任务内容——一句话祈使句，UI 中展示。 */
  readonly content: string;
  /** 生命周期状态；`in_progress` 标记正在做的（并行工作可标记多条）。 */
  readonly status: TodoStatus;
}
