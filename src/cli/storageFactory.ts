/**
 * 会话存储后端工厂（StorageFactory）——按 `--storage-adapter` 构造存储端口（Factory 模式）。
 *
 * ## 为什么单独成类（审计 §3.4「存储后端有两套独立字符串工厂」的收口）
 *
 * 此前「存储后端名 → 具体类 + 缺省落盘路径」的分支直接写在 `cliBuildConfig.buildStorage` 里，
 * 而 KV 后端在同一仓里另有一份同形实现（`kvStoreFactory.createFor`，且它已把缺省文件名收成常量）。
 * 两处的缺省值各自内联 ⇒ 改一个缺省要么改两处、要么漏一处。现与会话存储对齐到同一形态：
 * **后端名 → 实现 + 缺省**只在本类里判断，`cliBuildConfig` 只做一次转发。
 *
 * 设计要点（与 `KvStoreFactory` 同构，便于对照维护）：
 *  - 单一职责：只负责「选择并构造存储后端」，不碰命令行输出与退出码；
 *  - sqlite 后端**懒加载**（`node:sqlite` 仅 Node ≥22.5 提供，静态导入会让旧 Node 上
 *    所有命令启动即崩）；
 *  - 无状态，可安全复用同一实例。
 */

import { MemoryStorage } from '../adapters/storage/memoryStorage.js';
import { JsonlStorage } from '../adapters/storage/jsonlStorage.js';
import type { SqliteStorage } from '../adapters/storage/sqliteStorage.js';

/** 存储端口句柄（工厂产出的三种后端之一）。 */
export type StorageHandle = MemoryStorage | JsonlStorage | SqliteStorage;

/** 会话存储：缺省 sqlite 落盘文件名（未给 `--storage-dir` 时落在工作目录）。 */
export const DEFAULT_SQLITE_FILE = 'omniharness.db';

/** 会话存储后端工厂（无状态）。 */
export class StorageFactory {
  /**
   * 按后端名构造存储端口（单一实现来源）。
   *
   * `cliBuildConfig.buildStorage` 与子代理的存储重定位都经此方法，
   * 避免缺省落盘路径在两处各写一遍而漂移。
   * @param adapter 后端名（`memory` | `jsonl` | `sqlite`）；未识别时按 `memory`（无落盘副作用）。
   * @param dir 落盘目录（jsonl）或 sqlite 文件名；缺省时用该后端的内置缺省（`memory` 忽略此参数）。
   * @returns 存储端口句柄。
   */
  public async createFor(adapter: string, dir: string | undefined): Promise<StorageHandle> {
    if (adapter === 'jsonl') {
      return new JsonlStorage(dir ?? process.cwd());
    }
    if (adapter === 'sqlite') {
      const { SqliteStorage } = await import('../adapters/storage/sqliteStorage.js');
      return new SqliteStorage(dir ?? DEFAULT_SQLITE_FILE);
    }
    return new MemoryStorage();
  }
}

/** 默认实例（无状态，调用点以 `storageFactory.createFor(...)` 零构造复用）。 */
export const storageFactory = new StorageFactory();
