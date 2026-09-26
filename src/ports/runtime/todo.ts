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
 *
 * `sessionId` 为**可选**参数（缺省表示「无会话归属」的全局桶）。为什么要显式分桶
 * （2026-09-26 审计 F7/F9）：待办端口在组合根是**进程级单例**，长跑 server 上所有会话
 * （含 Web 多线程与子代理）共用一张整表 —— 子代理写一次待办就会把父会话的清单整表覆盖掉，
 * 且「会话级 last-write-wins」的语义在多会话下根本不成立。
 */
export interface TodoPort {
  readonly name: string;
  /** 全量替换指定会话的待办列表（latest-write-wins）。 */
  snapshot(items: readonly TodoItem[], sessionId?: string): void;
  /** 取指定会话的当前待办列表（首次写入前为空）。 */
  list(sessionId?: string): readonly TodoItem[];
}
