import type { RpcRequest } from './rpcRequest.ts';
import type { RpcResponse } from './rpcResponse.ts';
import type { RpcNotification } from './rpcNotification.ts';

/** 统一消息类型。 */
export type RpcMessage = RpcRequest | RpcResponse | RpcNotification;
