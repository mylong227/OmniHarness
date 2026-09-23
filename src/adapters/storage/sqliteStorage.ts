import type { DatabaseSync } from 'node:sqlite';
import { createRequire } from 'node:module';
import type { SessionEvent } from '../../ports/runtime/event.js';
import type { StoragePort } from '../../ports/memory/storage.js';

/** 惰性加载 node:sqlite（Node 20 兼容铁律）：顶层静态 import 会在 Node 20 上
 * 直接炸掉整个模块加载链（ERR_UNKNOWN_BUILTIN_MODULE），连「根本不用 sqlite」
 * 的入口（如 smoke）都无法启动。改为首次实例化时 require，Node 22+ 行为不变，
 * Node 20 仅在真正选择 sqlite 存储时才得到清晰错误（fail-closed 可诊断）。
 * @returns node:sqlite 的 DatabaseSync 类；模块不可用时抛出带修复建议的错误。
 */

/** SQLite 存储适配器（node:sqlite）：events 表按会话分桶，可替换 JSONL。 */
export class SqliteStorage implements StoragePort {
  /** 适配器标识：用于端口注册与诊断日志归组（固定值 'sqlite'）。 */
  public readonly name = 'sqlite';
  /** 底层数据库文件路径（构造时锁定，供诊断与定位）。 */
  public readonly location: string;

  /** 底层数据库连接（events 表已就绪）。 */
  private readonly db: DatabaseSync;

  /**
   * 构造存储适配器：惰性加载 node:sqlite、打开数据库并确保 events 表存在。
   * @param filePath SQLite 数据库文件路径。
   */
  public constructor(filePath: string) {
    const DatabaseSyncImpl = SqliteStorage.loadDatabaseSync();
    this.location = filePath;
    this.db = new DatabaseSyncImpl(filePath);
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS events (session_id TEXT, seq INTEGER, data TEXT, PRIMARY KEY (session_id, seq))',
    );
  }

  /** 保存会话事件（整会话覆盖写）。
   * @param sessionId 会话标识（分桶键）。
   * @param events 完整事件列表（先删旧桶再按序号逐条插入，seq 为数组下标）。
   
   * @returns 无返回值。
   */
  public async save(sessionId: string, events: readonly SessionEvent[]): Promise<void> {
    const del = this.db.prepare('DELETE FROM events WHERE session_id = ?');
    del.run(sessionId);
    const insert = this.db.prepare('INSERT INTO events (session_id, seq, data) VALUES (?, ?, ?)');
    for (let index = 0; index < events.length; index += 1) {
      insert.run(sessionId, index, JSON.stringify(events[index]));
    }
  }

  /** 加载会话事件（不存在返回空）。
   * @param sessionId 会话标识。
   * @returns 按 seq 升序解析出的事件列表。
   */
  public async load(sessionId: string): Promise<readonly SessionEvent[]> {
    const rows = this.db
      .prepare('SELECT data FROM events WHERE session_id = ? ORDER BY seq')
      .all(sessionId) as { data: string }[];
    return rows.map((row) => JSON.parse(row.data) as SessionEvent);
  }

  /** 关闭数据库。
   * @returns 无返回值。
   */
  public close(): void {
    this.db.close();
  }
  /**
   * loadDatabaseSync — module-level helper moved into SqliteStorage.
   * @returns {typeof DatabaseSync} - result
   */
  private static loadDatabaseSync(): typeof DatabaseSync {
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
}
