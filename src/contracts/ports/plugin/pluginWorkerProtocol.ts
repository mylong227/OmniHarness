/**
 * Plugin Worker 协议 v1（ADR-0012）。
 *
 * 只声明跨进程的**纯数据契约**；不引入任何实现或第三方依赖，保证 ports 纯度。
 * 传输为 NDJSON：一行一个 JSON 对象，单帧上限由 Supervisor 执行。
 */

/** 协议版本（不匹配即拒绝，不做隐式兼容）。 */
export const PLUGIN_WORKER_PROTOCOL_VERSION = 1;

/** Worker 错误码（父进程与 Worker 共用）。 */
export type PluginWorkerErrorCode =
  | 'UNAUTHORIZED_CAPABILITY'
  | 'UNKNOWN_CAPABILITY'
  | 'INVALID_FRAME'
  | 'VERSION_MISMATCH'
  | 'ACTIVATION_TIMEOUT'
  | 'CALL_TIMEOUT'
  | 'WORKER_CRASHED'
  | 'WORKER_QUARANTINED'
  | 'INVALID_TOOL'
  | 'TOOL_LIMIT'
  | 'RESULT_TOO_LARGE'
  | 'SANDBOX_UNAVAILABLE'
  | 'UNSUPPORTED_METHOD';

/** 协议错误对象。 */
export interface PluginWorkerError {
  readonly code: PluginWorkerErrorCode;
  readonly message: string;
}

/** 父进程 → Worker 请求。 */
export interface PluginWorkerRequest {
  readonly v: 1;
  readonly session: string;
  readonly kind: 'req';
  readonly id: number;
  readonly method:
    | 'plugin.activate'
    | 'plugin.deactivate'
    | 'tool.invoke'
    | 'tool.cancel'
    | 'event.deliver'
    | 'health.ping';
  readonly params: unknown;
}

/** Worker → 父进程响应。 */
export type PluginWorkerResponse =
  | {
      readonly v: 1;
      readonly session: string;
      readonly kind: 'res';
      readonly id: number;
      readonly ok: true;
      readonly result: unknown;
    }
  | {
      readonly v: 1;
      readonly session: string;
      readonly kind: 'res';
      readonly id: number;
      readonly ok: false;
      readonly error: PluginWorkerError;
    };

/** Worker → 父进程事件（不等待响应）。 */
export interface PluginWorkerEvent {
  readonly v: 1;
  readonly session: string;
  readonly kind: 'evt';
  readonly method: 'tool.register' | 'tool.unregister' | 'cap.call' | 'log' | 'fault' | 'ready';
  readonly params: unknown;
}

/** Worker → 父进程能力调用（等待父进程响应）。 */
export interface PluginWorkerCapabilityRequest {
  readonly v: 1;
  readonly session: string;
  readonly kind: 'cap';
  readonly id: number;
  readonly capability: string;
  readonly method: string;
  readonly params: unknown;
}

/** 父进程 → Worker 能力响应。 */
export interface PluginWorkerCapabilityResponse {
  readonly v: 1;
  readonly session: string;
  readonly kind: 'capres';
  readonly id: number;
  readonly ok: boolean;
  readonly result?: unknown;
  readonly error?: PluginWorkerError;
}

/** Worker 发出的任一条消息。 */
export type PluginWorkerInbound =
  PluginWorkerResponse | PluginWorkerEvent | PluginWorkerCapabilityRequest;

/** 握手（父 → Worker）。 */
export interface PluginWorkerHello {
  readonly v: 1;
  readonly kind: 'hello';
  readonly session: string;
  readonly nonce: string;
  readonly plugin: { readonly name: string; readonly version: string };
}

/** 握手完成（Worker → 父）。 */
export interface PluginWorkerReady {
  readonly v: 1;
  readonly kind: 'ready';
  readonly session: string;
  readonly nonce: string;
  readonly pid: number;
  readonly sdk: '1';
}

/** Worker 注册的工具：定义 + 处理器句柄。 */
export interface PluginWorkerToolRegistration {
  readonly definition: {
    readonly name: string;
    readonly description: string;
    readonly parameters: unknown;
    readonly deferred?: boolean;
  };
  readonly handler: string;
}

/** 父进程调用 Worker 工具的参数。 */
export interface PluginWorkerToolInvoke {
  readonly callId: string;
  readonly tool: string;
  readonly args: unknown;
  readonly context: { readonly sessionId: string; readonly workspaceRoot: string };
}

/** Worker 返回的工具结果（父进程会再做大小/形状校验）。 */
export interface PluginWorkerToolResult {
  readonly callId: string;
  readonly ok: boolean;
  readonly output?: string;
  readonly error?: string;
}

/** 能力调用（Worker → 父）。 */
export interface PluginWorkerCapabilityCall {
  readonly capability: string;
  readonly method: string;
  readonly params: unknown;
}
