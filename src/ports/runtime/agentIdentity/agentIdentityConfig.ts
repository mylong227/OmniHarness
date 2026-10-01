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
