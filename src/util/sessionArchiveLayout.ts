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

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

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
    const main = SessionArchiveLayout.mainFileOf(dir, sessionId);
    const arch = SessionArchiveLayout.archivedFileOf(dir, sessionId);
    SessionArchiveLayout.cleanupInterrupted(main, arch);
    if (existsSync(arch) && !existsSync(main)) return 'noop';
    if (!existsSync(main)) return existsSync(arch) ? 'noop' : 'missing';
    return SessionArchiveLayout.moveFile(main, arch) === 'missing' ? 'missing' : 'moved';
  }

  /**
   * 恢复：`archive/` → 主目录。
   * @param dir 存档主目录
   * @param sessionId 会话 id
   * @returns `moved`（挪回）/ `missing`（两处都没有）/ `noop`（本就在主目录）
   */
  public static restore(dir: string, sessionId: string): ArchiveMoveResult {
    const main = SessionArchiveLayout.mainFileOf(dir, sessionId);
    const arch = SessionArchiveLayout.archivedFileOf(dir, sessionId);
    SessionArchiveLayout.cleanupInterrupted(arch, main);
    if (existsSync(main) && !existsSync(arch)) return 'noop';
    if (!existsSync(arch)) return existsSync(main) ? 'noop' : 'missing';
    return SessionArchiveLayout.moveFile(arch, main) === 'missing' ? 'missing' : 'moved';
  }

  /**
   * 挪一个文件（同分区 `rename`；**跨分区退化为「复制 → 校验大小 → 目标目录内原子改名 → 删源」**）。
   *
   * 为什么要有跨分区分支：`rename` 跨设备会抛 `EXDEV`。存储目录挂在另一个卷上时，归档会直接失败。
   * 退化路径的顺序是刻意的：先复制到**目标目录**的临时文件（同分区改名才是原子的）→ 校验大小一致 →
   * 原子改名就位 → 最后删源。任何一步中断都不会留下半截的目标文件；最坏是「源还在、目标也已就位」，
   * 由 {@link cleanupInterrupted} 在下次归档/恢复时按大小判定并清掉多余的一份。
   * @param src 源路径
   * @param dest 目标路径
   * @param renameImpl rename 实现（**仅供单测注入失败以验证跨分区回退**）
   * @returns `moved` / `missing`（源不存在）
   */
  public static moveFile(
    src: string,
    dest: string,
    renameImpl: (from: string, to: string) => void = renameSync,
  ): 'moved' | 'missing' {
    if (!existsSync(src)) return 'missing';
    mkdirSync(dirname(dest), { recursive: true });
    try {
      renameImpl(src, dest);
      return 'moved';
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
    }
    return SessionArchiveLayout.copyAcross(src, dest, renameImpl);
  }

  /**
   * 跨分区搬运：复制 → 校验大小 → 目标目录内原子改名 → 删源。
   * @param src 源路径
   * @param dest 目标路径
   * @param renameImpl rename 实现（与 {@link moveFile} 同一个，便于单测注入）
   * @returns `moved`；校验失败时抛错（**不删源**，宁可留下源也不丢数据）
   */
  private static copyAcross(
    src: string,
    dest: string,
    renameImpl: (from: string, to: string) => void,
  ): 'moved' {
    const tmp = `${dest}.${process.pid}.tmp`;
    copyFileSync(src, tmp);
    const srcSize = statSync(src).size;
    const tmpSize = statSync(tmp).size;
    if (srcSize !== tmpSize) {
      rmSync(tmp, { force: true });
      throw new Error(
        `跨分区复制校验失败：源 ${srcSize} 字节 ≠ 目标 ${tmpSize} 字节（源文件保留）`,
      );
    }
    renameImpl(tmp, dest); // 目标目录内 ⇒ 同分区 ⇒ 原子
    unlinkSync(src);
    return 'moved';
  }

  /**
   * 清理「上一次跨分区搬运被打断」留下的重复：两份都在时按大小判定谁是半截。
   *
   * 判据刻意保守：**只有大小相同才删副本**（说明复制已完整）；大小不同则删掉**目标侧**那份
   * （半截的总是在目标侧，因为它是由源复制出来的）。
   * @param src 源（权威侧：本次要搬走的那份所在位置）
   * @param dest 目标（可能是上次留下的副本）
   * @returns 无返回值
   */
  private static cleanupInterrupted(src: string, dest: string): void {
    if (!existsSync(src) || !existsSync(dest)) return;
    try {
      if (statSync(src).size === statSync(dest).size) rmSync(src, { force: true });
      else rmSync(dest, { force: true });
    } catch {
      /* 清理失败不阻断主流程：下一次归档/恢复会再试 */
    }
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
