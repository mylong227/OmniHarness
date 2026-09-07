/** JSON-RPC 2.0 请求。 */
export interface RpcRequest {
  readonly jsonrpc: '2.0';
  readonly id: number | string;
  readonly method: string;
  readonly params?: Record<string, unknown>;
}

/** JSON-RPC 2.0 响应。 */
export interface RpcResponse {
  readonly jsonrpc: '2.0';
  readonly id: number | string;
  readonly result?: unknown;
  readonly error?: RpcError;
}

/** JSON-RPC 2.0 通知（无 id）。 */
export interface RpcNotification {
  readonly jsonrpc: '2.0';
  readonly method: string;
  readonly params?: Record<string, unknown>;
}

/** JSON-RPC 2.0 错误。 */
export interface RpcError {
  readonly code: number;
  readonly message: string;
}

/** 统一消息类型。 */
export type RpcMessage = RpcRequest | RpcResponse | RpcNotification;

/** JSON-RPC 协议工具。 */
export class JsonRpc {
  /** 是否为请求或通知（含 method）。 */
  static isCall(message: RpcMessage): message is RpcRequest | RpcNotification {
    return 'method' in message;
  }

  /** 是否为带 id 的请求。 */
  static isRequest(message: RpcMessage): message is RpcRequest {
    return 'method' in message && 'id' in message;
  }

  /** 构造响应。 */
  static response(id: number | string, result: unknown): RpcResponse {
    return { jsonrpc: '2.0', id, result };
  }

  /** 构造请求（带 id 的调用）。 */
  static request(
    id: number | string,
    method: string,
    params?: Record<string, unknown>,
  ): RpcRequest {
    return { jsonrpc: '2.0', id, method, params };
  }

  /** 构造错误响应。 */
  static errorResponse(id: number | string, code: number, message: string): RpcResponse {
    return { jsonrpc: '2.0', id, error: { code, message } };
  }

  /** 构造通知。 */
  static notify(method: string, params: Record<string, unknown>): RpcNotification {
    return { jsonrpc: '2.0', method, params };
  }

  /** 解析消息（无效 JSON 或非 RPC 结构返回 undefined）。 */
  static parse(raw: string): RpcMessage | undefined {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed === 'object' && parsed !== null && 'jsonrpc' in parsed) {
        return parsed as RpcMessage;
      }
      return undefined;
    } catch {
      return undefined;
    }
  }
}
