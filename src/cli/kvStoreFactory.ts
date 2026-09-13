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
    return this.createFor(reader.value('--kv-adapter'), reader.value('--kv-file'));
  }

  /**
   * 按已解析的「后端名 + 落盘路径」构造 KV 端口（单一实现来源）。
   *
   * `create()` 与装配期凭据水合（F3）都经此方法，避免默认文件名在两处各写一遍而漂移。
   * @param adapter 后端名（memory | json-file | sqlite）；省略或未识别时按 json-file。
   * @param file 落盘路径；省略时用该后端的内置默认文件名（memory 忽略此参数）。
   * @returns KV 端口句柄（调用方负责 close）。
   */
  public async createFor(adapter: string | undefined, file: string | undefined): Promise<KvHandle> {
    if (adapter === 'memory') {
      return new MemoryKv();
    }
    if (adapter === 'sqlite') {
      const { SqliteKv } = await import('../adapters/kv/sqliteKv.js');
      return new SqliteKv(file ?? DEFAULT_SQLITE_FILE);
    }
    return new JsonFileKv(file ?? DEFAULT_JSON_FILE);
  }
}
