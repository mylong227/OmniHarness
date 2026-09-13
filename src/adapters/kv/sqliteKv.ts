import { DatabaseSync } from 'node:sqlite';
import type { KvPort } from '../../ports/memory/kv.js';

/** SQLite KV 适配器（node:sqlite）：kv 表持久化，可替换 JSON 文件。 */
export class SqliteKv implements KvPort {
  /** 端口名：SQLite 后端标识，与 KvPort 契约的适配器命名空间一致。 */
  public readonly name = 'sqlite';

  /** 底层 SQLite 数据库连接（kv 表：key 主键 + value 文本）。 */
  private readonly db: DatabaseSync;

  /**
   * @param filePath SQLite 数据库文件路径（不存在则自动创建）。
   */
  public constructor(filePath: string) {
    this.db = new DatabaseSync(filePath);
    this.db.exec('CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT)');
  }

  /** 读取键值；不存在返回 undefined。
   * @param key 要读取的键。
   * @returns 键对应的值；不存在时为 undefined。
   */
  public async get(key: string): Promise<string | undefined> {
    const row = this.db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as
      { value: string } | undefined;
    return row?.value;
  }

  /** 写入（或覆盖）键值（INSERT ... ON CONFLICT upsert）。
   * @param key 要写入的键。
   * @param value 要写入的值（覆盖旧值）。
   * @returns 无返回值。
   */
  public async set(key: string, value: string): Promise<void> {
    this.db
      .prepare(
        'INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      )
      .run(key, value);
  }

  /** 删除键；实际删除了行（changes > 0）返回 true，不存在返回 false。
   * @param key 要删除的键。
   * @returns 键存在且已删除为 true，否则为 false。
   */
  public async delete(key: string): Promise<boolean> {
    const result = this.db.prepare('DELETE FROM kv WHERE key = ?').run(key);
    return result.changes > 0;
  }

  /** 键是否存在（SELECT 1 探测，不取值）。
   * @param key 要检查的键。
   * @returns 键存在为 true。
   */
  public async has(key: string): Promise<boolean> {
    const row = this.db.prepare('SELECT 1 AS x FROM kv WHERE key = ?').get(key) as
      { x: number } | undefined;
    return row !== undefined;
  }

  /** 全部键（按字典序排序）。
   * @returns 全部键的数组（字典序）。
   */
  public async keys(): Promise<readonly string[]> {
    const rows = this.db.prepare('SELECT key FROM kv ORDER BY key').all() as { key: string }[];
    return rows.map((row) => row.key);
  }

  /**
   * 按前缀列举键值对（LIKE `prefix%`，按字典序排序）。
   * @param prefix 键前缀，空串匹配全部。
   * @returns 匹配条目的键值对数组。
   */
  public async list(prefix = ''): Promise<readonly { key: string; value: string }[]> {
    const rows = this.db
      .prepare('SELECT key, value FROM kv WHERE key LIKE ? ORDER BY key')
      .all(`${prefix}%`) as { key: string; value: string }[];
    return rows;
  }

  /** 关闭底层 SQLite 数据库连接，释放文件句柄。
   * @returns 无返回值。
   */
  public async close(): Promise<void> {
    this.db.close();
  }
}
