/** JSON-RPC 2.0 错误。 */
export interface RpcError {
  readonly code: number;
  readonly message: string;
}
