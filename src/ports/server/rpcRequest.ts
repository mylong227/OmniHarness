/** JSON-RPC 2.0 请求。 */
export interface RpcRequest {
  readonly jsonrpc: '2.0';
  readonly id: number | string;
  readonly method: string;
  readonly params?: Record<string, unknown> | undefined;
}
