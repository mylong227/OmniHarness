/**
 * @beta
 * 断言载荷解码后的声明。
 */
export interface AgentIdentityClaims {
  /** 可复用运行时身份（跨多次运行）。 */
  readonly agentRuntimeId: string;
  /** 单次运行任务 id（scoped 到一次 Codex/harness 运行）。 */
  readonly taskId: string;
  /** ISO-8601 时间戳，防止重放。 */
  readonly timestamp: string;
}
