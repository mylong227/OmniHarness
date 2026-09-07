import { DatabaseSync } from 'node:sqlite';
import type { KvPort } from '../../ports/kv.js';

/** SQLite KV 适配器（node:sqlite）：kv 表持久化，可替换 JSON 文件。 */
export class SqliteKv implements KvPort {
  readonly name = 'sqlite';

  private readonly db: DatabaseSync;

  constructor(filePath: string) {
    this.db = new DatabaseSync(filePath);
    this.db.exec('CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT)');
  }

  async get(key: string): Promise<string | undefined> {
    const row = this.db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as
      { value: string } | undefined;
    return row?.value;
  }

  async set(key: string, value: string): Promise<void> {
    this.db
      .prepare(
        'INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      )
      .run(key, value);
  }

  async delete(key: string): Promise<boolean> {
    const result = this.db.prepare('DELETE FROM kv WHERE key = ?').run(key);
    return result.changes > 0;
  }

  async has(key: string): Promise<boolean> {
    const row = this.db.prepare('SELECT 1 AS x FROM kv WHERE key = ?').get(key) as
      { x: number } | undefined;
    return row !== undefined;
  }

  async keys(): Promise<readonly string[]> {
    const rows = this.db.prepare('SELECT key FROM kv ORDER BY key').all() as { key: string }[];
    return rows.map((row) => row.key);
  }

  async list(prefix = ''): Promise<readonly { key: string; value: string }[]> {
    const rows = this.db
      .prepare('SELECT key, value FROM kv WHERE key LIKE ? ORDER BY key')
      .all(`${prefix}%`) as { key: string; value: string }[];
    return rows;
  }

  async close(): Promise<void> {
    this.db.close();
  }
}
