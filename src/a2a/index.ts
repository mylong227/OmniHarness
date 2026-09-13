/**
 * A2A 互操作模块（U6）统一出口。
 */
export type {
  A2aTransport,
  A2aCapability,
  A2aCapabilityDeclaration,
  DelegateRequest,
  DelegateResult,
} from './a2aProtocol.js';
export {
  A2A_CAPABILITIES_DECLARE,
  A2A_TASK_DELEGATE,
  A2A_ERROR_INVALID,
  A2A_ERROR_UNAUTHORIZED,
  A2A_ERROR_METHOD_NOT_FOUND,
} from './a2aProtocol.js';
export { A2aClient } from './a2aClient.js';
export { A2aServer, type TaskHandler } from './a2aServer.js';
export { HttpA2aTransport, HttpA2aServerTransport } from './httpA2aTransport.js';
export { WsA2aTransport, WsA2aServerTransport, A2A_WS_PATH } from './wsA2aTransport.js';
