/** JSON-RPC 2.0 错误。 */
export interface RpcError {
  readonly code: number;
  readonly message: string;
  /** 结构化附加信息（MCP 2026-07-28 的 `-32022`/`-32021` 用它带 supported/requiredCapabilities）。 */
  readonly data?: unknown;
}
