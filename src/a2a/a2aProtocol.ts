/**
 * **私有** agent 间委托协议（U6 场间共振委托通道）。
 *
 * ⚠️ INT-05（2026-10-20）：本文件定义的是 `capabilities.declare` / `task.delegate` 私有方法，
 * **不是 A2A v1.0 规范**。A2A v1.0 互操作面（`message/send` / `tasks/get` / `agent/getCard`）
 * 实现在 `A2aServer` 的 v1 分支；两者共用同一 `TaskHandler`，但协议名不得混称。
 */

export type { A2aTransport } from '../ports/a2a/a2aTransport.ts';

/** 能力声明方法名。 */
export const A2A_CAPABILITIES_DECLARE = 'capabilities.declare';
/** 任务委托方法名。 */
export const A2A_TASK_DELEGATE = 'task.delegate';
/** A2A v1.0：发送消息（任务入口）。 */
export const A2A_MESSAGE_SEND = 'message/send';
/** A2A v1.0：查询任务。 */
export const A2A_TASKS_GET = 'tasks/get';
/** A2A v1.0：取 AgentCard。 */
export const A2A_AGENT_GET_CARD = 'agent/getCard';

/** A2A v1.0 AgentCard（最小互操作面）。 */
export interface A2aAgentCard {
  readonly name: string;
  readonly description: string;
  readonly version: string;
  readonly url?: string;
  readonly capabilities?: { readonly streaming?: boolean; readonly pushNotifications?: boolean };
  readonly skills?: readonly {
    readonly id: string;
    readonly name: string;
    readonly description?: string;
  }[];
}

/** A2A v1.0 Task 状态。 */
export type A2aTaskState = 'submitted' | 'working' | 'completed' | 'failed' | 'canceled';

/** A2A v1.0 Task（最小互操作面）。 */
export interface A2aTask {
  readonly id: string;
  readonly contextId?: string;
  readonly status: { readonly state: A2aTaskState; readonly timestamp?: string };
  readonly artifacts?: readonly {
    readonly artifactId?: string;
    readonly parts: readonly { readonly type: 'text'; readonly text: string }[];
  }[];
  readonly error?: string;
}

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
