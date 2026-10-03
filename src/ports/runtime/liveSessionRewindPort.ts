/**
 * 在跑会话事件流回卷端口（**检查点回滚的内存侧契约**）。
 *
 * ## 与 `server/services/session/sessionRewindService` 的分工（勿混）
 *
 * - `SessionRewindService`（服务端 RPC `threads.rewind`）只动**持久化事实源**，并且在
 *   「该会话有回合在跑」时**直接拒绝**——所以它天然不会与内存态打架。
 * - 本端口解决的是另一半：`rollback` 工具在**会话内部**执行（此刻必然有回合在跑），
 *   磁盘写回之后必须把**内存事件流**一并截断，否则下一步 write-behind 落盘会把回滚覆盖回去
 *   （2026-10-03 登记的 P1 缺陷）。
 *
 * 两者都以「回卷」为名，但作用对象不同（磁盘 vs 内存），故类名以 **Live** 前缀区分。
 */
export interface LiveSessionRewindPort {
  /**
   * 把指定会话的事件流截断到 `size` 条（内存 + 持久化对齐 + 检索索引清理）。
   * @param sessionId 目标会话 ID。
   * @param size 截断后保留的事件条数（通常取检查点 meta 的 `eventCount`）。
   * @returns 是否命中在跑会话：`true` = 已回卷；`false` = 本进程没有在跑该会话
   *   （此时磁盘回滚已足够，调用方不得据此判失败）。
   */
  rewind(sessionId: string, size: number): Promise<boolean>;
}
