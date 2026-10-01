import type { AgentIdentityClaims } from './agentIdentityClaims.js';

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
