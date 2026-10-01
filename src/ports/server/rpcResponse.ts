import type { RpcError } from './rpcError.js';

/** JSON-RPC 2.0 响应。 */
export interface RpcResponse {
  readonly jsonrpc: '2.0';
  readonly id: number | string;
  readonly result?: unknown;
  readonly error?: RpcError;
}
