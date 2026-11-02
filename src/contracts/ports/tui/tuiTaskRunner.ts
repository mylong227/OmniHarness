/**
 * TUI 任务执行端口——TUI 桥对「能跑一轮任务」的**最小结构要求**。
 *
 * ## 为什么是端口而不是直接依赖 `Agent`
 *
 * `ports/` 不得绑定实现层（架构门禁 [3.5]）；`Agent` 在 `core/`，直接引用会把端口层焊死在实现上。
 * 本端口按结构声明 `Agent` 已有的两个成员（`runTask` / `resume`），`Agent` 无需改动即结构性满足；
 * 单测则可用假实现驱动错误路径（真实 Agent 故意跑挂的代价太高）。
 */

/** 一次任务执行的结果子集（`AgentResult` 的结构投影，只取桥所需字段）。 */
export interface TuiTaskResult {
  /** 会话 ID（多轮续跑的衔接键）。 */
  readonly sessionId: string;
  /** 最终答复文本（可缺省：中断/异常路径可能没有）。 */
  readonly finalText?: string | undefined;
}

/** TUI 桥所需的任务执行面。 */
export interface TuiTaskRunner {
  /**
   * 开新会话跑一轮任务。
   * @param prompt 用户输入文本。
   * @returns 会话结果（至少含 sessionId）。
   */
  runTask(prompt: string): Promise<TuiTaskResult>;
  /**
   * 续跑既有会话（多轮对话的衔接路径）。
   * @param sessionId 既有会话 ID。
   * @param prompt 本轮新增的用户输入。
   * @returns 会话结果（至少含 sessionId）。
   */
  resume(sessionId: string, prompt: string): Promise<TuiTaskResult>;
}
