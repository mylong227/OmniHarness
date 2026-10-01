/**
 * @beta
 * 待办端口（对标 DeepSeek `packages/todo/tool-todo`）。
 *
 * 语义刻意极简：整表快照、last-write-wins，条目无需稳定 id。模型用 `todo_write`
 * 全量替换列表，UI/模型用 `todo_read` 取最新快照。用于长任务进度可控性。
 */

export type { TodoStatus } from './todo/todoStatus.js';
export type { TodoItem } from './todo/todoItem.js';
export type { TodoPort } from './todo/todoPort.js';
