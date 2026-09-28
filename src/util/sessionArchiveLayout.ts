// 会话存档的**文件布局**：主目录 + `archive/` 子目录（归档 = 冷存储）。
//
// ## 为什么归档要真的挪文件（2026-09-27 用户要求「把归档冷存储也做完」）
//
// 只把归档会话从列表里过滤掉，磁盘上它们与活跃会话**毫无区别**：任何按目录扫描 / 按 id 拼路径的读取
// 都会照旧命中它们（检索、统计、回放都可能带进来）。归档要成为一件**真事**，就得让「归档会话不在
// 主目录里」这条不变量成立：挪进 `archive/` 子目录，**恢复时挪回来**。
//
// 挪动是本类唯一的写操作，且一律用 `rename`（同分区原子）：任何时刻文件要么在主目录、要么在归档目录，
// 不存在「两边都没有」或「两边都有（半截）」的中间态。
//
// ## 谁必须知道这件事（这就是本类存在的意义：**只有一处**定义路径规则）
//
// - 会话服务（列表 / 改名 / 删除 / 分叉 / 归档）：读写侧车与挪文件；
// - 事件存储（`JsonlStorage` 的 load/save）与遥测读取（`sessionEventReader`）：**读不到主目录时要回落
//   归档目录**，否则「打开归档会话看历史」会得到空历史（比报错更糟：看起来像历史丢了）；
// - 写入前 `ensureMain`：续聊一个已归档的会话时**先把文件挪回来**，避免「主目录新建一个只有新事件的
//   文件」把历史劈成两半。
//
// 纯路径规则 + 同步 fs，无 React/无业务状态，可单测（见 tests/unit/sessionArchiveLayout.test.ts）。

import { existsSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';

/** 归档子目录名（与 `.jsonl` 同级）。 */
export const ARCHIVE_DIR_NAME = 'archive';

/** 挪动结果。 */
export type ArchiveMoveResult = 'moved' | 'missing' | 'noop';

/** 会话存档文件布局：主目录 + `archive/`。 */
export class SessionArchiveLayout {
  /**
   * 归档子目录的绝对路径（不创建）。
   * @param dir 存档主目录
   * @returns `archive/` 路径
   */
  public static archiveDirOf(dir: string): string {
    return join(dir, ARCHIVE_DIR_NAME);
  }

  /**
   * 主目录下的会话文件路径。
   * @param dir 存档主目录
   * @param sessionId 会话 id
   * @returns 路径
   */
  public static mainFileOf(dir: string, sessionId: string): string {
    return join(dir, `${sessionId}.jsonl`);
  }

  /**
   * 归档目录下的会话文件路径。
   * @param dir 存档主目录
   * @param sessionId 会话 id
   * @returns 路径
   */
  public static archivedFileOf(dir: string, sessionId: string): string {
    return join(SessionArchiveLayout.archiveDirOf(dir), `${sessionId}.jsonl`);
  }

  /**
   * 找到会话文件（主目录优先，其次归档目录）。
   * @param dir 存档主目录
   * @param sessionId 会话 id
   * @returns 存在的文件路径；两处都没有返回 undefined
   */
  public static find(dir: string, sessionId: string): string | undefined {
    const main = SessionArchiveLayout.mainFileOf(dir, sessionId);
    if (existsSync(main)) return main;
    const arch = SessionArchiveLayout.archivedFileOf(dir, sessionId);
    return existsSync(arch) ? arch : undefined;
  }

  /**
   * 该会话是否位于归档目录。
   * @param dir 存档主目录
   * @param sessionId 会话 id
   * @returns 在归档目录返回 true
   */
  public static isArchived(dir: string, sessionId: string): boolean {
    return existsSync(SessionArchiveLayout.archivedFileOf(dir, sessionId));
  }

  /**
   * 归档：主目录 → `archive/`。
   * @param dir 存档主目录
   * @param sessionId 会话 id
   * @returns `moved`（挪了）/ `missing`（两处都没有）/ `noop`（已在归档目录）
   */
  public static archive(dir: string, sessionId: string): ArchiveMoveResult {
    if (SessionArchiveLayout.isArchived(dir, sessionId)) return 'noop';
    const main = SessionArchiveLayout.mainFileOf(dir, sessionId);
    if (!existsSync(main)) return 'missing';
    mkdirSync(SessionArchiveLayout.archiveDirOf(dir), { recursive: true });
    renameSync(main, SessionArchiveLayout.archivedFileOf(dir, sessionId));
    return 'moved';
  }

  /**
   * 恢复：`archive/` → 主目录。
   * @param dir 存档主目录
   * @param sessionId 会话 id
   * @returns `moved`（挪回）/ `missing`（两处都没有）/ `noop`（本就在主目录）
   */
  public static restore(dir: string, sessionId: string): ArchiveMoveResult {
    const arch = SessionArchiveLayout.archivedFileOf(dir, sessionId);
    if (!existsSync(arch)) {
      return existsSync(SessionArchiveLayout.mainFileOf(dir, sessionId)) ? 'noop' : 'missing';
    }
    mkdirSync(dir, { recursive: true });
    renameSync(arch, SessionArchiveLayout.mainFileOf(dir, sessionId));
    return 'moved';
  }

  /**
   * 写入前的准备：主目录没有文件、但归档目录有 ⇒ 先挪回来（避免把历史劈成两半）。
   * @param dir 存档主目录
   * @param sessionId 会话 id
   * @returns `main`（本就在主目录或无需处理）/ `restored`（刚从归档挪回）/ `absent`（两处都没有）
   */
  public static ensureMain(dir: string, sessionId: string): 'main' | 'restored' | 'absent' {
    if (existsSync(SessionArchiveLayout.mainFileOf(dir, sessionId))) return 'main';
    if (!SessionArchiveLayout.isArchived(dir, sessionId)) return 'absent';
    return SessionArchiveLayout.restore(dir, sessionId) === 'moved' ? 'restored' : 'absent';
  }
}
