/**
 * KV 端口：通用键值存储的统一插口（可换后端：内存/JSON 文件/SQLite/云）。
 *
 * 用于凭据保险库、会话状态、模型记忆、配置覆盖等非会话事件类持久化数据。
 * 与 {@link StoragePort} 分工：StoragePort 存会话事件序列，KV 存任意键值。
 */
export interface KvPort {
  readonly name: string;
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<boolean>;
  has(key: string): Promise<boolean>;
  keys(): Promise<readonly string[]>;
  /** 枚举指定前缀下的全部键值。 */
  list(prefix?: string): Promise<readonly { key: string; value: string }[]>;
  /** 关闭底层资源。 */
  close(): Promise<void>;
}
