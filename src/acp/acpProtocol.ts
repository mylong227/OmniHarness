/**
 * Agent Client Protocol（ACP）v1 数据模型与常量。
 *
 * ACP 由编辑器（Zed / JetBrains 等）作为 **Client**、编码 agent 作为 **Agent**，
 * 通过 **JSON-RPC 2.0 over stdio** 通信。本文件只放协议面（方法名、错误码、结构类型），
 * 不依赖任何运行时实现；服务端装配见 `AcpServer`。
 *
 * 规范：https://agentclientprotocol.com/protocol/v1/（协议版本为单个整数 `1`）。
 */

/** 本端支持的 ACP 协议主版本（v1）。 */
export const ACP_PROTOCOL_VERSION = 1;

/** initialize：连接建立后协商版本 / 能力 / 认证方式。 */
export const ACP_METHOD_INITIALIZE = 'initialize';
/** session/new：创建新会话。 */
export const ACP_METHOD_SESSION_NEW = 'session/new';
/** session/load：加载既有会话并回放历史。 */
export const ACP_METHOD_SESSION_LOAD = 'session/load';
/** session/prompt：在会话内跑一轮用户提示。 */
export const ACP_METHOD_SESSION_PROMPT = 'session/prompt';
/** session/cancel：取消正在进行的回合（通知，无响应）。 */
export const ACP_METHOD_SESSION_CANCEL = 'session/cancel';
/** session/update：Agent → Client 的流式会话更新（通知）。 */
export const ACP_METHOD_SESSION_UPDATE = 'session/update';
/** session/request_permission：Agent → Client 的权限请求（带 id 的请求）。 */
export const ACP_METHOD_REQUEST_PERMISSION = 'session/request_permission';

/** 未认证（会话创建前需 authenticate；本端暂不启用认证流程，保留错误码）。 */
export const ACP_ERROR_AUTH_REQUIRED = -32000;
/** 非法请求。 */
export const ACP_ERROR_INVALID_REQUEST = -32600;
/** 未知方法。 */
export const ACP_ERROR_METHOD_NOT_FOUND = -32601;
/** 非法参数（会话不存在 / prompt 为空 / cwd 非绝对路径等）。 */
export const ACP_ERROR_INVALID_PARAMS = -32602;
/** 服务端内部错误。 */
export const ACP_ERROR_INTERNAL = -32603;

/** 权限请求策略：`client` = 写类工具问 Client；`auto` = 全部自动放行。 */
export type AcpPermissionMode = 'client' | 'auto';

/** 权限策略白名单（CLI 取值 fail-closed 校验的唯一来源）。 */
export const ACP_PERMISSION_MODES: readonly AcpPermissionMode[] = ['client', 'auto'];

/** ACP 结束原因（session/prompt 的 result.stopReason）。 */
export type AcpStopReason =
  'end_turn' | 'max_tokens' | 'max_turn_requests' | 'refusal' | 'cancelled';

/** 实现信息（clientInfo / agentInfo）。 */
export interface AcpImplementation {
  /** 程序化名称（如 `omniharness`）。 */
  readonly name: string;
  /** 面向用户的标题。 */
  readonly title?: string | undefined;
  /** 版本号。 */
  readonly version?: string | undefined;
}

/** Client 能力（本端只读其子集，未知字段忽略）。 */
export interface AcpClientCapabilities {
  /** 文件系统能力（Agent 可反向调用 fs/*）。 */
  readonly fs?: {
    readonly readTextFile?: boolean;
    readonly writeTextFile?: boolean;
  };
  /** 是否支持全部 terminal/* 方法。 */
  readonly terminal?: boolean;
  /** 前向兼容：未知能力键原样保留。 */
  readonly [key: string]: unknown;
}

/** initialize 请求。 */
export interface AcpInitializeRequest {
  /** Client 支持的最新协议主版本。 */
  readonly protocolVersion: number;
  /** Client 能力。 */
  readonly clientCapabilities?: AcpClientCapabilities | undefined;
  /** Client 实现信息。 */
  readonly clientInfo?: AcpImplementation | undefined;
}

/** Agent 能力。 */
export interface AcpAgentCapabilities {
  /** 是否支持 session/load。 */
  readonly loadSession?: boolean;
  /** prompt 可携带的内容类型。 */
  readonly promptCapabilities?: {
    readonly image?: boolean;
    readonly audio?: boolean;
    readonly embeddedContext?: boolean;
  };
  /** MCP 传输能力（本端暂不连接 Client 提供的 MCP server）。 */
  readonly mcpCapabilities?: { readonly http?: boolean; readonly sse?: boolean };
  /** 其他会话能力（本端不声明）。 */
  readonly sessionCapabilities?: Record<string, unknown>;
}

/** initialize 响应。 */
export interface AcpInitializeResponse {
  /** 生效的协议主版本。 */
  readonly protocolVersion: number;
  /** Agent 能力。 */
  readonly agentCapabilities: AcpAgentCapabilities;
  /** Agent 实现信息。 */
  readonly agentInfo?: AcpImplementation;
  /** 认证方式（本端为空）。 */
  readonly authMethods?: readonly unknown[];
}

/** 文本内容块。 */
export interface AcpTextBlock {
  /** 判别字段。 */
  readonly type: 'text';
  /** 文本载荷。 */
  readonly text: string;
}

/** 图片内容块。 */
export interface AcpImageBlock {
  /** 判别字段。 */
  readonly type: 'image';
  /** base64 编码的媒体数据。 */
  readonly data: string;
  /** MIME 类型。 */
  readonly mimeType: string;
  /** 可选 URI。 */
  readonly uri?: string | undefined;
}

/** 音频内容块。 */
export interface AcpAudioBlock {
  /** 判别字段。 */
  readonly type: 'audio';
  /** base64 编码的媒体数据。 */
  readonly data: string;
  /** MIME 类型。 */
  readonly mimeType: string;
}

/** 资源链接内容块（Agent 可自行读取）。 */
export interface AcpResourceLinkBlock {
  /** 判别字段。 */
  readonly type: 'resource_link';
  /** 资源 URI。 */
  readonly uri: string;
  /** 展示名称。 */
  readonly name: string;
  /** 可选 MIME 类型。 */
  readonly mimeType?: string | undefined;
  /** 可选描述。 */
  readonly description?: string | undefined;
}

/** 内嵌资源内容块。 */
export interface AcpResourceBlock {
  /** 判别字段。 */
  readonly type: 'resource';
  /** 资源内容（文本或二进制）。 */
  readonly resource: {
    readonly uri: string;
    readonly mimeType?: string | undefined;
    readonly text?: string | undefined;
    readonly blob?: string | undefined;
  };
}

/** ACP 内容块（与 MCP 的 content block 兼容）。 */
export type AcpContentBlock =
  AcpTextBlock | AcpImageBlock | AcpAudioBlock | AcpResourceLinkBlock | AcpResourceBlock;

/** MCP server 连接描述（stdio 形态；本端记录但不连接）。 */
export interface AcpMcpServer {
  /** 名称。 */
  readonly name: string;
  /** 可执行文件（绝对路径）。 */
  readonly command: string;
  /** 命令行参数。 */
  readonly args?: readonly string[];
  /** 环境变量。 */
  readonly env?: readonly { readonly name: string; readonly value: string }[];
}

/** session/new 请求。 */
export interface AcpNewSessionRequest {
  /** 工作目录（必须是绝对路径）。 */
  readonly cwd: string;
  /** 会话要连接的 MCP server 列表。 */
  readonly mcpServers?: readonly AcpMcpServer[];
  /** 额外工作区根（本端能力未声明，接受但忽略）。 */
  readonly additionalDirectories?: readonly string[];
}

/** session/new / load 响应。 */
export interface AcpSessionResponse {
  /** 会话唯一 id。 */
  readonly sessionId?: string;
  /** 可选的会话配置（本端不提供）。 */
  readonly configOptions?: readonly unknown[] | null;
}

/** session/load 请求。 */
export interface AcpLoadSessionRequest {
  /** 要加载的会话 id。 */
  readonly sessionId: string;
  /** 工作目录（必须是绝对路径）。 */
  readonly cwd: string;
  /** 会话要连接的 MCP server 列表。 */
  readonly mcpServers?: readonly AcpMcpServer[];
  /** 额外工作区根。 */
  readonly additionalDirectories?: readonly string[];
}

/** session/prompt 请求。 */
export interface AcpPromptRequest {
  /** 目标会话 id。 */
  readonly sessionId: string;
  /** 用户消息内容块。 */
  readonly prompt: readonly AcpContentBlock[];
}

/** session/prompt 响应。 */
export interface AcpPromptResponse {
  /** 结束原因。 */
  readonly stopReason: AcpStopReason;
}

/** session/cancel 通知。 */
export interface AcpCancelNotification {
  /** 要取消的会话 id。 */
  readonly sessionId: string;
}

/** 工具类别（Client 据此选择图标/展示方式）。 */
export type AcpToolKind =
  | 'read'
  | 'edit'
  | 'delete'
  | 'move'
  | 'search'
  | 'execute'
  | 'think'
  | 'fetch'
  | 'switch_mode'
  | 'other';

/** 工具调用状态。 */
export type AcpToolCallStatus = 'pending' | 'in_progress' | 'completed' | 'failed';

/** 工具调用产出的内容。 */
export type AcpToolCallContent =
  | { readonly type: 'content'; readonly content: AcpContentBlock }
  | {
      readonly type: 'diff';
      readonly path: string;
      readonly oldText?: string | null;
      readonly newText: string;
    }
  | { readonly type: 'terminal'; readonly terminalId: string };

/** 工具调用 / 工具调用更新。 */
export interface AcpToolCallUpdate {
  /** 会话内唯一工具调用 id（与 tool_result 配对）。 */
  readonly toolCallId: string;
  /** 人类可读标题。 */
  readonly title?: string | undefined;
  /** 工具程序名。 */
  readonly name?: string | undefined;
  /** 工具类别。 */
  readonly kind?: AcpToolKind | undefined;
  /** 当前状态。 */
  readonly status?: AcpToolCallStatus | undefined;
  /** 产出的内容。 */
  readonly content?: readonly AcpToolCallContent[] | undefined;
  /** 原始入参。 */
  readonly rawInput?: unknown;
  /** 原始产出。 */
  readonly rawOutput?: unknown;
  /** 涉及的文件位置。 */
  readonly locations?: readonly { readonly path: string; readonly line?: number }[] | undefined;
}

/** 计划项状态。 */
export type AcpPlanEntryStatus = 'pending' | 'in_progress' | 'completed';

/** 计划项。 */
export interface AcpPlanEntry {
  /** 这一步要做什么。 */
  readonly content: string;
  /** 相对重要性。 */
  readonly priority: 'high' | 'medium' | 'low';
  /** 当前状态。 */
  readonly status: AcpPlanEntryStatus;
}

/** 消息类更新（用户 / Agent / 思考）。 */
export interface AcpMessageChunkUpdate {
  /** `user_message_chunk`（仅回放）/ `agent_message_chunk` / `agent_thought_chunk`。 */
  readonly sessionUpdate: 'user_message_chunk' | 'agent_message_chunk' | 'agent_thought_chunk';
  /** 可选消息 id（同一消息的分片共享）。 */
  readonly messageId?: string | undefined;
  /** 内容块。 */
  readonly content: AcpContentBlock;
}

/** 新建工具调用更新。 */
export interface AcpToolCallStartUpdate extends AcpToolCallUpdate {
  /** 判别字段。 */
  readonly sessionUpdate: 'tool_call';
}

/** 工具调用更新。 */
export interface AcpToolCallUpdateUpdate extends AcpToolCallUpdate {
  /** 判别字段。 */
  readonly sessionUpdate: 'tool_call_update';
}

/** 计划更新（每次都必须给全量条目）。 */
export interface AcpPlanUpdate {
  /** 判别字段。 */
  readonly sessionUpdate: 'plan';
  /** 全量计划条目。 */
  readonly entries: readonly AcpPlanEntry[];
}

/** session/update 通知的 payload。 */
export type AcpSessionUpdate =
  AcpMessageChunkUpdate | AcpToolCallStartUpdate | AcpToolCallUpdateUpdate | AcpPlanUpdate;

/** 权限选项类别。 */
export type AcpPermissionOptionKind =
  'allow_once' | 'allow_always' | 'reject_once' | 'reject_always';

/** 权限选项。 */
export interface AcpPermissionOption {
  /** 选项 id（Client 回传）。 */
  readonly optionId: string;
  /** 展示名称。 */
  readonly name: string;
  /** 选项类别。 */
  readonly kind: AcpPermissionOptionKind;
}

/** session/request_permission 请求。 */
export interface AcpPermissionRequest {
  /** 会话 id。 */
  readonly sessionId: string;
  /** 需要授权的工具调用。 */
  readonly toolCall: AcpToolCallUpdate;
  /** 可选项（至少包含 allow_once / reject_once）。 */
  readonly options: readonly AcpPermissionOption[];
}

/** 权限结果：选中某个选项，或整轮被取消。 */
export type AcpPermissionOutcome =
  { readonly outcome: 'selected'; readonly optionId: string } | { readonly outcome: 'cancelled' };

/** session/request_permission 响应。 */
export interface AcpPermissionResponse {
  /** 用户决策。 */
  readonly outcome: AcpPermissionOutcome;
}

/** 判断值是否为普通对象。 */
export const isAcpRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
