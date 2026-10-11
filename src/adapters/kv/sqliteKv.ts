import type { DatabaseSync } from 'node:sqlite';
import { createRequire } from 'node:module';
import type { KvPort } from '../../ports/memory/kv.js';

/** SQLite KV 适配器（node:sqlite）：kv 表持久化，可替换 JSON 文件。 */
export class SqliteKv implements KvPort {
  /** 端口名：SQLite 后端标识，与 KvPort 契约的适配器命名空间一致。 */
  public readonly name = 'sqlite';

  /**
   * `node:sqlite` 模块加载器（**可注入的缝**，缺省 = 真实 `createRequire`）。
   *
   * 为什么要这个缝：本类的两条失败路径（模块抛错 / 模块未导出 `DatabaseSync`）在**装了 Node 22
   * 的环境里不可达**，于是"模块不可用时给出可行动建议"这条能力没有任何判据——2026-10-11 它一度
   * 被当成"不可达的防御分支"直接改写覆盖率冻结值（那是纸面处置）。加缝后两条路径都能被真实触发：
   * 判据把本字段换成替身，**走的就是下面 `loadDatabaseSync` 的原逻辑**（不是包一层）。
   *
   * 只在同进程内的判据里替换，判据结束即恢复（node:test 同文件内用例串行，无并发污染）。
   * @param specifier 模块说明符（本类只传 `'node:sqlite'`）。
   * @returns 模块命名空间对象。
   */
  public static requireImpl: (specifier: string) => unknown = (specifier) =>
    createRequire(import.meta.url)(specifier);

  /** 底层 SQLite 数据库连接（kv 表：key 主键 + value 文本）。 */
  private readonly db: DatabaseSync;

  /**
   * @param filePath SQLite 数据库文件路径（不存在则自动创建）。
   */
  public constructor(filePath: string) {
    this.db = new (SqliteKv.loadDatabaseSync())(filePath);
    this.db.exec('CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT)');
  }

  /**
   * 惰性加载 `node:sqlite`（与 `SqliteStorage.loadDatabaseSync` 同一口径）。
   *
   * ## 为什么必须惰性（2026-10-08 易用性轮实测）
   *
   * 原先本文件顶层是 `import { DatabaseSync } from 'node:sqlite'`，而 `src/adapters/index.ts`
   * 这条 barrel 会把它**静态**带进 CLI 的装配链（`cliServerCmds` → `adapters/index` → 本文件）。
   * 于是**每一条**命令（`doctor` / `session list` / 甚至 `kv list --kv-adapter memory`）都会先
   * 在 stderr 打一行：
   *
   * ```
   * (node:12345) ExperimentalWarning: SQLite is an experimental feature and might change at any time
   * ```
   *
   * 对客户而言这就是"一启动就报错"——而它既不是错误，也不该在**没用到 sqlite** 时出现。
   * 同类文件 `sqliteStorage.ts` 早已是这个写法（并写明了 Node 20 兼容铁律），本文件漏了，
   * 而 `kvStoreFactory.ts` 的注释还写着"sqlite 后端**懒加载**"——**声明与实现不一致**，
   * 本行修的就是这条不一致：懒加载从"文档里的说法"变成"代码里的事实"。
   * @returns node:sqlite 的 DatabaseSync 类；模块不可用时抛出带修复建议的错误。
   */
  private static loadDatabaseSync(): typeof DatabaseSync {
    try {
      // CJS require 返回模块命名空间对象（{ DatabaseSync }），不是类本身——
      // 直接 new 模块对象会炸「not a constructor」（与 SqliteStorage 同一处实测结论）。
      // 走可注入的 `requireImpl`（缺省即真实 createRequire）⇒ 判据能真实触发下面两条失败路径。
      const mod = SqliteKv.requireImpl('node:sqlite') as {
        DatabaseSync: typeof DatabaseSync;
      };
      if (typeof mod?.DatabaseSync !== 'function') {
        throw new Error('node:sqlite 未导出 DatabaseSync');
      }
      return mod.DatabaseSync;
    } catch {
      throw new Error(
        'SqliteKv 需要 node:sqlite 内置模块（Node 22+）。' +
          '当前 Node 版本不可用；请改用 --kv-adapter json-file 或升级 Node。',
      );
    }
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
    // node:sqlite 返回的行是 **null 原型对象**（`[Object: null prototype]`）；照原样外传会让
    // 「同一端口、不同后端」返回**形状不同**的东西：`assert.deepStrictEqual` 直接不等、
    // `instanceof Object` 为 false。此处归一成普通对象，使 sqlite 与 json-file 两后端形状一致
    // （2026-10-11 由新增判据 `sqliteKvFailurePaths.test.ts` 当场抓到并钉住）。
    return rows.map((row) => ({ key: row.key, value: row.value }));
  }

  /** 关闭底层 SQLite 数据库连接，释放文件句柄。
   * @returns 无返回值。
   */
  public async close(): Promise<void> {
    this.db.close();
  }
}
