/**
 * Agent 密码学身份端口（#S33，对标 codex-rs/agent-identity 可移植核心）。
 *
 * 参考 codex 的 `agent-identity` 把整套能力绑死在 OpenAI 注册/JWKS 平台上；本端口只搬
 * **可移植的内核**——Ed25519 密钥对（PKCS#8 der 持久化）+ ssh-ed25519 公钥编码 +
 * 对「agent_runtime_id:task_id:timestamp」断言签名/验签。用于在零依赖前提下给 harness
 * 一个密码学身份：可对任意会话产物（工具结果、事件快照）签名，供下游验证「确由本 runtime 出具」。
 *
 * 零依赖：仅用 Node 内置 `node:crypto`（Ed25519 原生支持），不引入任何运行时包。
 */

export type { AgentIdentityClaims } from './agentIdentity/agentIdentityClaims.js';
export type { AgentIdentityConfig } from './agentIdentity/agentIdentityConfig.js';
export type { AgentIdentityPort } from './agentIdentity/agentIdentityPort.js';
