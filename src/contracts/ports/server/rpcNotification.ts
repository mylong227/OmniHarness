/** JSON-RPC 2.0 通知（无 id）。 */
export interface RpcNotification {
  readonly jsonrpc: '2.0';
  readonly method: string;
  readonly params?: Record<string, unknown>;
}
