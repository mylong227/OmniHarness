/**
 * KV 后端工厂（KvStoreFactory）——按 `--kv-adapter` 构造键值端口（Factory 模式）。
 *
 * 设计要点：
 *  - 单一职责：只负责「选择并构造 KV 后端」，不碰命令行输出与退出码，故可被 kv / vault 等命令复用。
 *  - 可移植：默认落盘文件名集中为常量；sqlite 后端**懒加载**（node:sqlite 仅 Node ≥22.5 提供，
 *    静态导入会让旧 Node 上所有命令启动即崩）。
 *  - 无状态，可安全复用同一实例。
 */

import { MemoryKv } from '../adapters/kv/memoryKv.js';
import { JsonFileKv } from '../adapters/kv/jsonFileKv.js';
import type { SqliteKv } from '../adapters/kv/sqliteKv.js';
import { CliArgReader } from './cliArgReader.js';

/** KV 端口句柄（工厂产出的三种后端之一）。 */
export type KvHandle = MemoryKv | JsonFileKv | SqliteKv;

/** 默认 JSON 文件后端落盘路径。 */
const DEFAULT_JSON_FILE = '.omniharness-kv.json';
/** 默认 SQLite 后端落盘路径。 */
const DEFAULT_SQLITE_FILE = '.omniharness-kv.db';

export class KvStoreFactory {
  /**
   * 按 `--kv-adapter`（memory | json-file | sqlite，缺省 json-file）构造 KV 端口。
   * @param args 命令行参数（读取 `--kv-adapter` / `--kv-file`）。
   * @returns KV 端口句柄（调用方负责 close）。
   */
  public async create(args: readonly string[]): Promise<KvHandle> {
    const reader = new CliArgReader(args);
    const adapter = reader.value('--kv-adapter') ?? 'json-file';
    if (adapter === 'memory') {
      return new MemoryKv();
    }
    if (adapter === 'sqlite') {
      const dbFile = reader.value('--kv-file') ?? DEFAULT_SQLITE_FILE;
      const { SqliteKv } = await import('../adapters/kv/sqliteKv.js');
      return new SqliteKv(dbFile);
    }
    return new JsonFileKv(reader.value('--kv-file') ?? DEFAULT_JSON_FILE);
  }
}
