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

/**
 * @beta
 * 断言载荷解码后的声明。
 */
export interface AgentIdentityClaims {
  /** 可复用运行时身份（跨多次运行）。 */
  readonly agentRuntimeId: string;
  /** 单次运行任务 id（scoped 到一次 Codex/harness 运行）。 */
  readonly taskId: string;
  /** ISO-8601 时间戳，防止重放。 */
  readonly timestamp: string;
}

/**
 * @beta
 * 身份配置（可选：提供则加载持久密钥，否则每次运行生成临时密钥）。
 */
export interface AgentIdentityConfig {
  /** PKCS#8 der 的 base64（参考 Rust 的 `private_key_pkcs8_base64`）。 */
  readonly privateKeyPkcs8Base64?: string | undefined;
  /** 运行时身份 id（缺省自动生成）。 */
  readonly agentRuntimeId?: string | undefined;
}

/**
 * @beta
 * Agent 密码学身份端口。
 *
 * 所有方法 fail-closed：验签失败返回 `null`/`false`，绝不抛错谎称通过。
 */
export interface AgentIdentityPort {
  /** 运行时身份 id。 */
  runtimeId(): string;

  /** ssh-ed25519 格式公钥（参考 Rust `encode_ssh_ed25519_public_key`）。 */
  publicKeySsh(): string;

  /** PKCS#8 der 的 base64 私钥（用于持久化，参考 Rust `private_key_pkcs8_base64`）。 */
  privateKeyPkcs8Base64(): string;

  /** 对原始负载做 Ed25519 签名，返回 base64 签名。 */
  sign(payload: string): string;

  /** 验证原始负载的 base64 签名。 */
  verify(payload: string, signatureB64: string): boolean;

  /** 签一个任务断言，返回 base64url 序列化的信封（参考 Rust `authorization_header_for_agent_task`）。 */
  signAssertion(taskId: string): string;

  /** 验一个任务断言信封，成功返回声明，失败/篡改返回 null。 */
  verifyAssertion(envelopeB64: string): AgentIdentityClaims | null;

  /** 形如 `AgentAssertion <envelope>` 的授权头（与参考镜像一致）。 */
  authorizationHeader(taskId: string): string;
}
