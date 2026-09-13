/**
 * 凭据保险库端口：敏感凭据（API Key / Token / 密码）的安全读写统一插口。
 *
 * 与 {@link KvPort} 分工：KV 存任意明文键值（缓存类），Vault 只存凭据且强调加密与最小暴露。
 * 典型后端：
 *  - {@link CryptoVault}：AES-256-GCM 加密落盘（复用 KV），主密钥来自环境变量/密钥文件
 *  - {@link EnvVault}：进程环境变量回退（未配置密钥时免落盘的只读凭据源）
 */
export interface VaultPort {
  readonly name: string;
  /** 读取凭据；不存在返回 undefined。 */
  getSecret(name: string): Promise<string | undefined>;
  /** 写入（或覆盖）凭据。 */
  setSecret(name: string, value: string): Promise<void>;
  /** 删除凭据；存在且删除成功返回 true。 */
  deleteSecret(name: string): Promise<boolean>;
  /** 凭据是否存在。 */
  hasSecret(name: string): Promise<boolean>;
  /** 列出全部凭据名（不泄露值）。 */
  listSecrets(): Promise<readonly string[]>;
  /** 关闭底层资源。 */
  close(): Promise<void>;
}
