import type { KvPort } from '../../ports/kv.js';

/** 内存 KV 适配器：进程内 Map，不持久化（测试 / 默认）。 */
export class MemoryKv implements KvPort {
  readonly name = 'memory';

  private readonly store = new Map<string, string>();

  async get(key: string): Promise<string | undefined> {
    return this.store.get(key);
  }

  async set(key: string, value: string): Promise<void> {
    this.store.set(key, value);
  }

  async delete(key: string): Promise<boolean> {
    return this.store.delete(key);
  }

  async has(key: string): Promise<boolean> {
    return this.store.has(key);
  }

  async keys(): Promise<readonly string[]> {
    return [...this.store.keys()];
  }

  async list(prefix = ''): Promise<readonly { key: string; value: string }[]> {
    const entries: { key: string; value: string }[] = [];
    for (const [key, value] of this.store) {
      if (key.startsWith(prefix)) {
        entries.push({ key, value });
      }
    }
    return entries;
  }

  async close(): Promise<void> {
    this.store.clear();
  }
}
