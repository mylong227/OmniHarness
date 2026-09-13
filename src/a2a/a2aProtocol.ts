/**
 * A2A 互操作协议（U6 场间共振委托通道）。
 *
 * 定义 agent 之间「能力声明 → 任务委托 → 结果回传」的最小 JSON-RPC 协议，
 * 以及可插拔的传输层抽象。协议与传输解耦：同一套消息既可在内存双端（测试）、
 * 也可在 HTTP/WebSocket（生产）上跑，fail-closed 由两端门禁保证。
 *
 * 零依赖（仅复用 server/jsonRpc 消息类型）。
 */
import type { RpcMessage } from '../server/core/jsonRpc.js';

/** 传输层抽象（A2A 自包含，不耦合 server 实现）。 */
export interface A2aTransport {
  /** 发送一条消息（请求/响应/通知）。 */
  send(message: RpcMessage): void;
  /** 订阅入站消息。 */
  onMessage(callback: (message: RpcMessage) => void): void;
  /** 可选：关闭传输（释放连接/端口）。 */
  close?(): void;
}

/** 能力声明方法名。 */
export const A2A_CAPABILITIES_DECLARE = 'capabilities.declare';
/** 任务委托方法名。 */
export const A2A_TASK_DELEGATE = 'task.delegate';

/** 单条能力描述。 */
export interface A2aCapability {
  /** 能力名（如 'code-review' / 'web-search'）。 */
  readonly name: string;
  /** 能力描述。 */
  readonly description?: string;
}

/** 能力声明载荷（可选带密码学身份签名）。 */
export interface A2aCapabilityDeclaration {
  /** 声明方 agent id。 */
  readonly agentId: string;
  /** 声明的能力清单。 */
  readonly capabilities: readonly A2aCapability[];
  /**
   * 由 AgentIdentityPort.authorizationHeader(taskId=agentId) 生成的签名断言；
   * 服务端若配置了对端身份，即验此签名（fail-closed：验不过即拒）。
   */
  readonly assertion?: string;
}

/** 任务委托请求。 */
export interface DelegateRequest {
  /** 本次委托唯一 id（用于幂等/追踪）。 */
  readonly taskId: string;
  /** 自包含任务描述（远端看不到本地历史，必须自包含）。 */
  readonly task: string;
  /** 父会话 id（便于审计关联）。 */
  readonly parentSessionId?: string;
  /** 授权给远端的工具子集；不传则远端自行决定。 */
  readonly tools?: readonly string[];
  /** 委托方 agent id。 */
  readonly requesterId?: string;
  /** 委托方签名断言（同 capabilities 的 assertion 语义）。 */
  readonly assertion?: string;
}

/** 任务委托结果。 */
export interface DelegateResult {
  /** 是否成功完成。 */
  readonly ok: boolean;
  /** 任务输出（文本）。 */
  readonly output: string;
  /** 远端实际步数。 */
  readonly steps: number;
  /** 远端耗时 ms。 */
  readonly durationMs: number;
  /** 失败原因（ok=false 时非空）。 */
  readonly error?: string;
}

/** JSON-RPC 错误码（与 MCP / AppServer 同源）。 */
export const A2A_ERROR_INVALID = -32602;
export const A2A_ERROR_UNAUTHORIZED = -32001;
export const A2A_ERROR_METHOD_NOT_FOUND = -32601;
