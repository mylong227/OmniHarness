import type { DatabaseSync } from 'node:sqlite';
import { createRequire } from 'node:module';
import type { SessionEvent } from '../../ports/event.js';
import type { StoragePort } from '../../ports/storage.js';

/**
 * 惰性加载 node:sqlite（Node 20 兼容铁律）：顶层静态 import 会在 Node 20 上
 * 直接炸掉整个模块加载链（ERR_UNKNOWN_BUILTIN_MODULE），连「根本不用 sqlite」
 * 的入口（如 smoke）都无法启动。改为首次实例化时 require，Node 22+ 行为不变，
 * Node 20 仅在真正选择 sqlite 存储时才得到清晰错误（fail-closed 可诊断）。
 */
function loadDatabaseSync(): typeof DatabaseSync {
  try {
    // CJS require 返回模块命名空间对象（{ DatabaseSync }），不是类本身——
    // 直接 new 模块对象会炸「not a constructor」（2026-09-09 实测修复）。
    const mod = createRequire(import.meta.url)('node:sqlite') as {
      DatabaseSync: typeof DatabaseSync;
    };
    if (typeof mod?.DatabaseSync !== 'function') {
      throw new Error('node:sqlite 未导出 DatabaseSync');
    }
    return mod.DatabaseSync;
  } catch {
    throw new Error(
      'SqliteStorage 需要 node:sqlite 内置模块（Node 22+）。' +
        '当前 Node 版本不可用；请改用 --storage jsonl 或升级 Node。',
    );
  }
}

/** SQLite 存储适配器（node:sqlite）：events 表按会话分桶，可替换 JSONL。 */
export class SqliteStorage implements StoragePort {
  public readonly name = 'sqlite';
  public readonly location: string;

  private readonly db: DatabaseSync;

  public constructor(filePath: string) {
    const DatabaseSyncImpl = loadDatabaseSync();
    this.location = filePath;
    this.db = new DatabaseSyncImpl(filePath);
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS events (session_id TEXT, seq INTEGER, data TEXT, PRIMARY KEY (session_id, seq))',
    );
  }

  /** 保存会话事件（整会话覆盖写）。 */
  public async save(sessionId: string, events: readonly SessionEvent[]): Promise<void> {
    const del = this.db.prepare('DELETE FROM events WHERE session_id = ?');
    del.run(sessionId);
    const insert = this.db.prepare('INSERT INTO events (session_id, seq, data) VALUES (?, ?, ?)');
    for (let index = 0; index < events.length; index += 1) {
      insert.run(sessionId, index, JSON.stringify(events[index]));
    }
  }

  /** 加载会话事件（不存在返回空）。 */
  public async load(sessionId: string): Promise<readonly SessionEvent[]> {
    const rows = this.db
      .prepare('SELECT data FROM events WHERE session_id = ? ORDER BY seq')
      .all(sessionId) as { data: string }[];
    return rows.map((row) => JSON.parse(row.data) as SessionEvent);
  }

  /** 关闭数据库。 */
  public close(): void {
    this.db.close();
  }
}
