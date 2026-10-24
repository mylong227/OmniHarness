/**
 * MCP 协议层错误（带 JSON-RPC 错误码与可选 `data`）。
 *
 * 与普通 `Error` 的区别：服务端按 `code` 原样回复（例如 `-32022` 协议版本不支持、
 * `-32021` 缺客户端能力），而普通异常一律收敛为 `-32602`。错误消息经
 * {@link McpSecretGuard} 脱敏后才上线缆。
 */
export class McpError extends Error {
  /**
   * @param code JSON-RPC 错误码。
   * @param message 可读消息（不得含 secret）。
   * @param data 结构化附加信息（可选）。
   */
  public constructor(
    public readonly code: number,
    message: string,
    public readonly data?: unknown,
  ) {
    super(message);
    this.name = 'McpError';
  }
}
