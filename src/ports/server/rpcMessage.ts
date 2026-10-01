import type { RpcRequest } from './rpcRequest.js';
import type { RpcResponse } from './rpcResponse.js';
import type { RpcNotification } from './rpcNotification.js';

/** 统一消息类型。 */
export type RpcMessage = RpcRequest | RpcResponse | RpcNotification;
