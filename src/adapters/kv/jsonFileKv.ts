import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { KvPort } from '../../ports/kv.js';

/**
 * JSON 文件 KV 适配器：单个 JSON 对象持久化到磁盘（零依赖，符合军规）。
 * 写操作原子化（先写临时文件再 rename），避免并发读写损坏。
 */
export class JsonFileKv implements KvPort {
  readonly name = 'json-file';

  private readonly filePath: string;
  private readonly tmpPath: string;
  private cache: Record<string, string> | undefined;

  constructor(filePath: string) {
    this.filePath = path.resolve(filePath);
    this.tmpPath = `${this.filePath}.tmp`;
  }

  /** 读取底层 JSON（带缓存，避免每次访问都读盘）。 */
  private async load(): Promise<Record<string, string>> {
    if (this.cache !== undefined) {
      return this.cache;
    }
    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
      this.cache = JSON.parse(raw) as Record<string, string>;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.cache = {};
      } else {
        throw error;
      }
    }
    return this.cache;
  }

  /** 原子写回磁盘。 */
  private async persist(): Promise<void> {
    if (this.cache === undefined) {
      return;
    }
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const raw = JSON.stringify(this.cache, null, 2);
    await fs.writeFile(this.tmpPath, raw, 'utf8');
    await fs.rename(this.tmpPath, this.filePath);
  }

  async get(key: string): Promise<string | undefined> {
    const store = await this.load();
    return store[key];
  }

  async set(key: string, value: string): Promise<void> {
    const store = await this.load();
    store[key] = value;
    await this.persist();
  }

  async delete(key: string): Promise<boolean> {
    const store = await this.load();
    if (!(key in store)) {
      return false;
    }
    delete store[key];
    await this.persist();
    return true;
  }

  async has(key: string): Promise<boolean> {
    const store = await this.load();
    return key in store;
  }

  async keys(): Promise<readonly string[]> {
    const store = await this.load();
    return Object.keys(store);
  }

  async list(prefix = ''): Promise<readonly { key: string; value: string }[]> {
    const store = await this.load();
    const entries: { key: string; value: string }[] = [];
    for (const [key, value] of Object.entries(store)) {
      if (key.startsWith(prefix)) {
        entries.push({ key, value });
      }
    }
    return entries;
  }

  async close(): Promise<void> {
    this.cache = undefined;
  }
}
