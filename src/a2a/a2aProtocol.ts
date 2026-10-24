/**
 * A2A 协议数据模型与常量。
 *
 * ⚠️ 协议面分两块，**不得混称**（INT-05，2026-10-20）：
 * - **A2A v1.0 互操作面**（对第三方客户端）：`message/send`、`message/stream`、`tasks/get`、
 *   `tasks/cancel`、`tasks/subscribe`、`tasks/pushNotificationConfig/*`、`agent/getCard`、
 *   `agent/getAuthenticatedExtendedCard`。
 * - **私有委托协议**（本仓 U6 历史面）：`capabilities.declare` / `task.delegate`。
 *   两者共用同一 `TaskHandler`，但协议名不得混称。
 *
 * 规范：https://a2a-protocol.org/v1.0.0/specification
 */

export type { A2aTransport } from '../ports/a2a/a2aTransport.ts';

/** 能力声明方法名（私有面）。 */
export const A2A_CAPABILITIES_DECLARE = 'capabilities.declare';
/** 任务委托方法名（私有面）。 */
export const A2A_TASK_DELEGATE = 'task.delegate';
/** A2A v1.0：发送消息（任务入口，阻塞返回终态 Task）。 */
export const A2A_MESSAGE_SEND = 'message/send';
/** A2A v1.0：流式发送消息（SSE / JSON-RPC streaming）。 */
export const A2A_MESSAGE_STREAM = 'message/stream';
/** A2A v1.0：查询任务。 */
export const A2A_TASKS_GET = 'tasks/get';
/** A2A v1.0：取消任务。 */
export const A2A_TASKS_CANCEL = 'tasks/cancel';
/** A2A v1.0：订阅既有任务的后续更新。 */
export const A2A_TASKS_SUBSCRIBE = 'tasks/subscribe';
/** A2A 0.x 旧名：与 `tasks/subscribe` 同义（兼容保留）。 */
export const A2A_TASKS_RESUBSCRIBE = 'tasks/resubscribe';
/** A2A v1.0：列出任务。 */
export const A2A_TASKS_LIST = 'tasks/list';
/** A2A v1.0：创建 push notification 配置。 */
export const A2A_PUSH_SET = 'tasks/pushNotificationConfig/set';
/** A2A v1.0：读取 push notification 配置。 */
export const A2A_PUSH_GET = 'tasks/pushNotificationConfig/get';
/** A2A v1.0：列出 push notification 配置。 */
export const A2A_PUSH_LIST = 'tasks/pushNotificationConfig/list';
/** A2A v1.0：删除 push notification 配置（幂等）。 */
export const A2A_PUSH_DELETE = 'tasks/pushNotificationConfig/delete';
/** A2A v1.0：取 AgentCard。 */
export const A2A_AGENT_GET_CARD = 'agent/getCard';
/** A2A v1.0：取认证后的扩展 AgentCard。 */
export const A2A_AGENT_GET_AUTHENTICATED_CARD = 'agent/getAuthenticatedExtendedCard';

/**
 * A2A v1.0 Task 状态（取小写枚举名，兼容本仓既有 v1 实现与历史测试）。
 *
 * 与规范枚举名的映射（JSON-RPC 绑定，规范 §4.1.3 / §5.5）：
 * - `auth_required` = `TASK_STATE_AUTH_REQUIRED`（0.x 写作 `auth-required`）；
 * - `input_required` = `TASK_STATE_INPUT_REQUIRED`（0.x 写作 `input-required`）。
 *
 * `auth_required` 与 `input_required` 都是**非终态**：任务仍可被 `tasks/get` 查询、
 * 被 `tasks/cancel` 取消，并可通过携带凭据的 `message/send` 续跑（§7.6 in-task authorization）。
 */
export type A2aTaskState =
  | 'submitted'
  | 'working'
  | 'completed'
  | 'failed'
  | 'canceled'
  | 'rejected'
  | 'input_required'
  | 'auth_required';

/** 消息角色（同时接受 0.x 小写与 1.0 ROLE_* 形态的读取方按需归一）。 */
export type A2aRole = 'user' | 'agent';

/** 文本内容片段。 */
export interface A2aTextPart {
  /** 判别字段。 */
  readonly type: 'text';
  /** 文本载荷。 */
  readonly text: string;
}

/** 文件内容片段（引用或内联 base64）。 */
export interface A2aFilePart {
  /** 判别字段。 */
  readonly type: 'file';
  /** 文件描述。 */
  readonly file: {
    /** 文件名。 */
    readonly name?: string;
    /** MIME 类型。 */
    readonly mimeType?: string;
    /** 内联 base64 字节。 */
    readonly bytes?: string;
    /** 或外部 URI。 */
    readonly uri?: string;
  };
}

/** 结构化数据片段。 */
export interface A2aDataPart {
  /** 判别字段。 */
  readonly type: 'data';
  /** JSON 数据。 */
  readonly data: Record<string, unknown>;
}

/** A2A 内容片段。 */
export type A2aPart = A2aTextPart | A2aFilePart | A2aDataPart;

/** A2A 消息。 */
export interface A2aMessage {
  /** 兼容 0.x 的可选判别字段。 */
  readonly kind?: 'message';
  /** 消息 id。 */
  readonly messageId: string;
  /** 角色。 */
  readonly role: A2aRole;
  /** 内容片段。 */
  readonly parts: readonly A2aPart[];
  /** 所属上下文。 */
  readonly contextId?: string;
  /** 所属任务。 */
  readonly taskId?: string;
  /** 附加元数据。 */
  readonly metadata?: Record<string, unknown>;
}

/** A2A v1.0 Task 状态对象。 */
export interface A2aTaskStatus {
  /** 状态机取值。 */
  readonly state: A2aTaskState;
  /** 状态时间戳（ISO 8601）。 */
  readonly timestamp?: string;
  /** 状态说明消息（如失败原因 / 需要输入时的提问）。 */
  readonly message?: A2aMessage;
}

/** A2A v1.0 Artifact。 */
export interface A2aArtifact {
  /** Artifact id。 */
  readonly artifactId?: string;
  /** 展示名。 */
  readonly name?: string;
  /** 内容片段。 */
  readonly parts: readonly A2aPart[];
}

/** A2A v1.0 Task（兼容最小互操作面）。 */
export interface A2aTask {
  /** 兼容 0.x 的可选判别字段。 */
  readonly kind?: 'task';
  /** 任务 id。 */
  readonly id: string;
  /** 上下文 id（多轮关联）。 */
  readonly contextId?: string;
  /** 状态。 */
  readonly status: A2aTaskStatus;
  /** 产出。 */
  readonly artifacts?: readonly A2aArtifact[];
  /** 历史消息（可选，本端暂不填充）。 */
  readonly history?: readonly A2aMessage[];
  /**
   * 任务级元数据（规范 §4.1.1 `metadata`）。
   *
   * 本仓用它承载**任务内认证请求**：任务落到 `auth_required` 时写入
   * `{ authChallenge: A2aAuthChallenge }`，凭据被接受并续跑后该键被移除。
   */
  readonly metadata?: Record<string, unknown>;
  /** 失败原因（兼容最小实现）。 */
  readonly error?: string;
}

/** Task 状态更新事件（stream / subscribe / push 共用）。 */
export interface A2aTaskStatusUpdateEvent {
  /** 任务 id。 */
  readonly taskId: string;
  /** 上下文 id。 */
  readonly contextId?: string;
  /** 新状态。 */
  readonly status: A2aTaskStatus;
  /** 是否为流内最后一条。 */
  readonly final: boolean;
}

/** Task 产出更新事件。 */
export interface A2aTaskArtifactUpdateEvent {
  /** 任务 id。 */
  readonly taskId: string;
  /** 上下文 id。 */
  readonly contextId?: string;
  /** 新增产出。 */
  readonly artifact: A2aArtifact;
  /** 是否为流内最后一条。 */
  readonly final: boolean;
}

/** 流式响应载荷（JSON-RPC result 或 push webhook body）。 */
export type A2aStreamResponse =
  | { readonly task: A2aTask }
  | { readonly statusUpdate: A2aTaskStatusUpdateEvent }
  | { readonly artifactUpdate: A2aTaskArtifactUpdateEvent };

/**
 * AgentCard 的 JWS 签名条目（规范 §4.4.7 `AgentCardSignature`）。
 *
 * 字段语义与 RFC 7515 的「分离载荷」一致：`signature` 对
 * `ASCII(protected ‖ "." ‖ BASE64URL(UTF8(规范化卡片正文)))` 签名——正文本身不重复携带。
 */
export interface A2aAgentCardSignature {
  /** base64url(JSON) 的 JWS Protected Header（至少含 `alg` 与 `kid`，可选 `typ` / `jku` / `exp`）。 */
  readonly protected: string;
  /** base64url 的签名值。 */
  readonly signature: string;
  /** 可选的 JWS Unprotected Header（明文 JSON，**不参与**签名）。 */
  readonly header?: Record<string, unknown>;
}

/** A2A v1.0 AgentCard（互操作面按需扩展）。 */
export interface A2aAgentCard {
  /** Agent 名称。 */
  readonly name: string;
  /** 描述。 */
  readonly description: string;
  /** 版本。 */
  readonly version: string;
  /** 服务端点 URL。 */
  readonly url?: string;
  /** 协议版本（v1.0 为 `1.0`）。 */
  readonly protocolVersion?: string;
  /** 能力声明。 */
  readonly capabilities?: {
    readonly streaming?: boolean;
    readonly pushNotifications?: boolean;
    readonly stateTransitionHistory?: boolean;
    readonly extendedAgentCard?: boolean;
  };
  /** 支持的协议接口（优先序）。 */
  readonly supportedInterfaces?: readonly {
    readonly url: string;
    readonly protocolBinding?: string;
    readonly protocolVersion?: string;
  }[];
  /** 输入模式。 */
  readonly defaultInputModes?: readonly string[];
  /** 输出模式。 */
  readonly defaultOutputModes?: readonly string[];
  /** 认证方案（如 HTTP Bearer / API Key / AgentAssertion）。 */
  readonly securitySchemes?: Readonly<Record<string, unknown>>;
  /** 认证要求（方案名 → scope 列表）。 */
  readonly security?: readonly Readonly<Record<string, readonly string[]>>[];
  /**
   * JWS 签名（规范 §8.4；可选）。
   *
   * **缺省即未签名**：客户端不得把「没有 signatures」推断成「已认证」。
   * 本仓只在显式配置了 Ed25519 私钥且开关打开时产出签名（见 `A2aAgentCardSigner`）。
   */
  readonly signatures?: readonly A2aAgentCardSignature[];
  /** 技能。 */
  readonly skills?: readonly {
    readonly id: string;
    readonly name: string;
    readonly description?: string;
    readonly tags?: readonly string[];
    readonly examples?: readonly string[];
  }[];
}

/**
 * 任务内认证请求（规范 §7.6 in-task authorization）。
 *
 * 由任务执行器在「继续执行需要凭据」时返回（`DelegateResult.authRequired`）；服务端把任务
 * 落到 `auth_required`，并把本结构放进 `status.message.metadata.authChallenge` 与
 * 任务级 `metadata.authChallenge`——客户端据此取凭据，再用 `message/send` 续跑。
 */
export interface A2aAuthChallenge {
  /** 需要的认证方案（如 `Bearer` / `AgentAssertion` / `OAuth2`）。 */
  readonly scheme: string;
  /** 面向人的说明（为何需要、如何取得凭据）。 */
  readonly description?: string;
  /** 完成授权的端点（可选）。 */
  readonly url?: string;
  /** 需要的权限范围（可选）。 */
  readonly scopes?: readonly string[];
  /** 附加参数（原样透传，供实现自定义语义）。 */
  readonly metadata?: Record<string, unknown>;
}

/** push notification 的 Webhook 目标。 */
export interface A2aPushNotificationConfig {
  /** 配置 id（服务端分配；set 时可省略）。 */
  readonly id?: string;
  /** Webhook URL（http/https）。 */
  readonly url: string;
  /** 校验令牌（服务端原样放进 `x-a2a-notification-token` 头）。 */
  readonly token?: string;
  /** 认证信息（scheme + credentials，用于 Authorization 头）。 */
  readonly authentication?: {
    readonly schemes?: readonly string[];
    readonly credentials?: string;
  };
}

/** Task 关联的 push notification 配置。 */
export interface A2aTaskPushNotificationConfig {
  /** 任务 id。 */
  readonly taskId: string;
  /** 配置。 */
  readonly pushNotificationConfig: A2aPushNotificationConfig;
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

/** 任务委托请求（私有面）。 */
export interface DelegateRequest {
  /** 本次委托唯一 id（用于幂等/追踪，同时作为 Agent 会话 id 以支持取消）。 */
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

/** 任务委托结果（私有面与 v1 执行器共用）。 */
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
  /** 是否被取消（A2A `tasks/cancel`；取消不是失败，v1 映射为 canceled 状态）。 */
  readonly canceled?: boolean;
  /**
   * 需要任务内认证（规范 §7.6；**不是失败**）。
   *
   * 返回它时 v1 服务端把任务落到 `auth_required` 并带上 challenge，绝不判完成；
   * 客户端带凭据续跑后执行器再次被调用（凭据经 `DelegateRequest.assertion` 传入）。
   */
  readonly authRequired?: A2aAuthChallenge;
}

/** JSON-RPC 错误码（与 A2A 1.0 规范 §5.4 对齐）。 */
export const A2A_ERROR_INVALID = -32602;
/**
 * 未认证。
 *
 * ⚠️ 2026-10-24：原值为 -32001，与 A2A 1.0 的 `TaskNotFoundError` **撞码**；现改为
 * 实现自定义段 -32000（规范未定义认证错误码，鉴权失败属绑定层语义）。
 */
export const A2A_ERROR_UNAUTHORIZED = -32000;
export const A2A_ERROR_METHOD_NOT_FOUND = -32601;
/** 任务不存在（-32001）。 */
export const A2A_ERROR_TASK_NOT_FOUND = -32001;
/** 任务不可取消（-32002）。 */
export const A2A_ERROR_TASK_NOT_CANCELABLE = -32002;
/** 未声明 push notification 能力（-32003）。 */
export const A2A_ERROR_PUSH_NOT_SUPPORTED = -32003;
/** 不支持的操作（-32004；如订阅终态任务 / 流式能力未开启）。 */
export const A2A_ERROR_UNSUPPORTED_OPERATION = -32004;
/** 内容类型不支持（-32005）。 */
export const A2A_ERROR_CONTENT_TYPE_NOT_SUPPORTED = -32005;
/** 扩展 AgentCard 未配置（-32007）。 */
export const A2A_ERROR_EXTENDED_CARD_NOT_CONFIGURED = -32007;
