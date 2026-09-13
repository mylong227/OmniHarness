/**
 * @beta
 * 待办端口（对标 DeepSeek `packages/todo/tool-todo`）。
 *
 * 语义刻意极简：整表快照、last-write-wins，条目无需稳定 id。模型用 `todo_write`
 * 全量替换列表，UI/模型用 `todo_read` 取最新快照。用于长任务进度可控性。
 */
export type TodoStatus = 'pending' | 'in_progress' | 'completed';

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

/**
 * @beta
 * 待办端口：会话级待办清单的统一插口。
 */
export interface TodoPort {
  readonly name: string;
  /** 全量替换当前待办列表（latest-write-wins）。 */
  snapshot(items: readonly TodoItem[]): void;
  /** 取当前待办列表（首次写入前为空）。 */
  list(): readonly TodoItem[];
}
