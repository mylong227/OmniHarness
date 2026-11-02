import type { TodoStatus } from './todoStatus.ts';

/**
 * @beta
 * 一条待办项。
 */
export interface TodoItem {
  /** 任务内容——一句话祈使句，UI 中展示。 */
  readonly content: string;
  /** 生命周期状态；一次最多一条 `in_progress`（由 todo_write 校验）。 */
  readonly status: TodoStatus;
  /** 稳定 id（可选）：仅当步骤之间需要 `dependsOn` 引用时提供。 */
  readonly id?: string;
  /** 依赖的前置步骤 id（可选）；用于表达严格顺序，环形/悬空引用一律拒绝。 */
  readonly dependsOn?: readonly string[];
}
