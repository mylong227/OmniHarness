/**
 * Agent Client Protocol（ACP）v1 适配层统一出口。
 *
 * - `AcpServer`：JSON-RPC over stdio 的 Agent 服务端。
 * - `AcpStdioTransport`：换行分隔 JSON-RPC 的 stdio 传输。
 * - `AgentAcpSession`：把 ACP 会话映射到现有 `Agent`（runTask/resume/cancel）。
 */
export type {
  AcpAgentCapabilities,
  AcpCancelNotification,
  AcpClientCapabilities,
  AcpContentBlock,
  AcpImplementation,
  AcpInitializeRequest,
  AcpInitializeResponse,
  AcpLoadSessionRequest,
  AcpMcpServer,
  AcpNewSessionRequest,
  AcpPermissionMode,
  AcpPermissionOption,
  AcpPermissionOutcome,
  AcpPermissionRequest,
  AcpPermissionResponse,
  AcpPlanEntry,
  AcpPromptRequest,
  AcpPromptResponse,
  AcpSessionResponse,
  AcpSessionUpdate,
  AcpStopReason,
  AcpToolCallContent,
  AcpToolCallStatus,
  AcpToolCallUpdate,
  AcpToolKind,
} from './acpProtocol.ts';
export {
  ACP_ERROR_AUTH_REQUIRED,
  ACP_ERROR_INTERNAL,
  ACP_ERROR_INVALID_PARAMS,
  ACP_ERROR_INVALID_REQUEST,
  ACP_ERROR_METHOD_NOT_FOUND,
  ACP_METHOD_INITIALIZE,
  ACP_METHOD_REQUEST_PERMISSION,
  ACP_METHOD_SESSION_CANCEL,
  ACP_METHOD_SESSION_LOAD,
  ACP_METHOD_SESSION_NEW,
  ACP_METHOD_SESSION_PROMPT,
  ACP_METHOD_SESSION_UPDATE,
  ACP_PERMISSION_MODES,
  ACP_PROTOCOL_VERSION,
} from './acpProtocol.ts';
export { AcpRequestError } from './acpRequestError.ts';
export { AcpEventMapper } from './acpEventMapper.ts';
export { AcpServer, type AcpServerOptions } from './acpServer.ts';
export { AcpStdioTransport, type AcpTransport } from './acpStdioTransport.ts';
export {
  AgentAcpSession,
  type AcpRunResult,
  type AcpSessionFactory,
  type AcpSessionOptions,
  type AcpSessionRuntime,
} from './agentAcpSession.ts';
