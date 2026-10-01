/** 钩子上下文。 */
export interface ToolHookContext {
  readonly sessionId: string;
  readonly toolName: string;
  readonly target: string;
  /**
   * 工具入参（#M5）：需要读 path/content 的钩子（如变更追踪）依赖它，纯观测钩子可忽略。
   * 调用点均会传入，类型标可选仅为兼容旧调用。
   */
  readonly args?: Record<string, unknown>;
}
