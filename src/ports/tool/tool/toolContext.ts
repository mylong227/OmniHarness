/** 工具执行上下文。 */
export interface ToolContext {
  readonly sessionId: string;
  readonly workspaceRoot: string;
  /**
   * 会话取消信号（V2 取消传播，可选）：由 `StepToolExecutor` 从本会话取消令牌注入。
   * 长任务工具（subagent / run_workflow / run_goal）据此把取消下传子代，
   * 使父取消后子代尽快收尾；缺省 undefined＝调用方未接取消链。
   */
  readonly signal?: AbortSignal | undefined;
}
