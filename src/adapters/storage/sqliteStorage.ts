import { DatabaseSync } from 'node:sqlite';
import type { SessionEvent } from '../../ports/event.js';
import type { StoragePort } from '../../ports/storage.js';

/** SQLite 存储适配器（node:sqlite）：events 表按会话分桶，可替换 JSONL。 */
export class SqliteStorage implements StoragePort {
  readonly name = 'sqlite';
  readonly location: string;

  private readonly db: DatabaseSync;

  constructor(filePath: string) {
    this.location = filePath;
    this.db = new DatabaseSync(filePath);
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS events (session_id TEXT, seq INTEGER, data TEXT, PRIMARY KEY (session_id, seq))',
    );
  }

  /** 保存会话事件（整会话覆盖写）。 */
  async save(sessionId: string, events: readonly SessionEvent[]): Promise<void> {
    const del = this.db.prepare('DELETE FROM events WHERE session_id = ?');
    del.run(sessionId);
    const insert = this.db.prepare('INSERT INTO events (session_id, seq, data) VALUES (?, ?, ?)');
    for (let index = 0; index < events.length; index += 1) {
      insert.run(sessionId, index, JSON.stringify(events[index]));
    }
  }

  /** 加载会话事件（不存在返回空）。 */
  async load(sessionId: string): Promise<readonly SessionEvent[]> {
    const rows = this.db
      .prepare('SELECT data FROM events WHERE session_id = ? ORDER BY seq')
      .all(sessionId) as { data: string }[];
    return rows.map((row) => JSON.parse(row.data) as SessionEvent);
  }

  /** 关闭数据库。 */
  close(): void {
    this.db.close();
  }
}
