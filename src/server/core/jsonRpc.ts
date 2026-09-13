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

/**
 * JSON-RPC 协议工具。
 *
 * 无隐式状态，同一实例可并发复用（默认实例见文件末尾组合根门面）。
 * `OOP 收口`（2026-09-11）：原静态方法族改为实例方法，消除 `static`。
 */
export class JsonRpc {
  /**
   * 是否为请求或通知（含 method）。
   * @param message 已解析的 RPC 消息。
   * @returns 含 method 返回 true（类型收窄为请求或通知）。
   */
  public isCall(message: RpcMessage): message is RpcRequest | RpcNotification {
    return 'method' in message;
  }

  /**
   * 是否为带 id 的请求。
   * @param message 已解析的 RPC 消息。
   * @returns 同时含 method 与 id 返回 true（类型收窄为 RpcRequest）。
   */
  public isRequest(message: RpcMessage): message is RpcRequest {
    return 'method' in message && 'id' in message;
  }

  /**
   * 构造响应。
   * @param id 对应请求的 id。
   * @param result 成功结果载荷。
   * @returns JSON-RPC 2.0 响应对象。
   */
  public response(id: number | string, result: unknown): RpcResponse {
    return { jsonrpc: '2.0', id, result };
  }

  /**
   * 构造请求（带 id 的调用）。
   * @param id 请求 id（响应按此关联）。
   * @param method 方法名。
   * @param params 方法参数（可选）。
   * @returns JSON-RPC 2.0 请求对象。
   */
  public request(
    id: number | string,
    method: string,
    params?: Record<string, unknown>,
  ): RpcRequest {
    return { jsonrpc: '2.0', id, method, params };
  }

  /**
   * 构造错误响应。
   * @param id 对应请求的 id。
   * @param code JSON-RPC 错误码（如 -32700、-32001）。
   * @param message 错误描述。
   * @returns 带 error 字段的响应对象。
   */
  public errorResponse(id: number | string, code: number, message: string): RpcResponse {
    return { jsonrpc: '2.0', id, error: { code, message } };
  }

  /**
   * 构造通知。
   * @param method 通知方法名。
   * @param params 通知参数。
   * @returns 无 id 的 JSON-RPC 2.0 通知对象。
   */
  public notify(method: string, params: Record<string, unknown>): RpcNotification {
    return { jsonrpc: '2.0', method, params };
  }

  /**
   * 解析消息（无效 JSON 或非 RPC 结构返回 undefined）。
   * @param raw 原始文本帧。
   * @returns 解析出的 RPC 消息；非法输入返回 undefined。
   */
  public parse(raw: string): RpcMessage | undefined {
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

// ---- 组合根门面：默认协议工具实例（调用点以 `jsonRpc.xxx` 零构造复用） ----
/** 默认 JSON-RPC 协议工具实例（无状态）。 */
export const jsonRpc = new JsonRpc();
