import type { KvPort } from '../../ports/kv.js';

/** 内存 KV 适配器：进程内 Map，不持久化（测试 / 默认）。 */
export class MemoryKv implements KvPort {
  /** 端口名：内存后端标识，与 KvPort 契约的适配器命名空间一致。 */
  public readonly name = 'memory';

  /** 进程内键值表（插入序，不持久化）。 */
  private readonly store = new Map<string, string>();

  /** 读取键值；不存在返回 undefined。
   * @param key 要读取的键。
   * @returns 键对应的值；不存在时为 undefined。
   */
  public async get(key: string): Promise<string | undefined> {
    return this.store.get(key);
  }

  /** 写入（或覆盖）键值。
   * @param key 要写入的键。
   * @param value 要写入的值（覆盖旧值）。
   * @returns 无返回值。
   */
  public async set(key: string, value: string): Promise<void> {
    this.store.set(key, value);
  }

  /** 删除键；存在且删除成功返回 true，不存在返回 false。
   * @param key 要删除的键。
   * @returns 键存在且已删除为 true，否则为 false。
   */
  public async delete(key: string): Promise<boolean> {
    return this.store.delete(key);
  }

  /** 键是否存在。
   * @param key 要检查的键。
   * @returns 键存在为 true。
   */
  public async has(key: string): Promise<boolean> {
    return this.store.has(key);
  }

  /** 全部键（插入序）。
   * @returns 全部键的数组。
   */
  public async keys(): Promise<readonly string[]> {
    return [...this.store.keys()];
  }

  /** 按前缀列举键值对；前缀为空串时返回全部条目。
   * @param prefix 键前缀，空串匹配全部。
   * @returns 匹配条目的键值对数组（插入序）。
   */
  public async list(prefix = ''): Promise<readonly { key: string; value: string }[]> {
    const entries: { key: string; value: string }[] = [];
    for (const [key, value] of this.store) {
      if (key.startsWith(prefix)) {
        entries.push({ key, value });
      }
    }
    return entries;
  }

  /** 关闭底层资源：内存后端无外部句柄，仅清空进程内 Map。
   * @returns 无返回值。
   */
  public async close(): Promise<void> {
    this.store.clear();
  }
}
