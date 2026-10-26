/**
 * 会话存档保留策略（GC）（2026-10-26，「彻底解决磁盘爆炸」的会话侧收口）。
 *
 * ## 为什么必须有它（实测数据）
 *
 * 会话存档在 `~/.omniharness/sessions`（归属根见 `OmniHome`）**只增不减**：本机 879 个会话、
 * 13 MB 只是当前值——每张截图附件外置成 `attachments/<sha256>.png`（几十 KB～几 MB），
 * 长会话 JSONL 动辄几 MB，没有保留策略的目录只有两个结局：被用户手删（历史丢了）或撑爆盘
 * （本轮 C 盘爆炸的会话侧形态）。
 *
 * ## 策略（三条，全部可注入以便判据）
 *
 * 1. **keepNewest 保护**：最新的 N 个会话组（缺省 50）无论多老、总量多大都**绝不删**——
 *    正在进行的会话一定是其中之一，这条是"自动 GC 不误伤"的主保险；
 * 2. **年龄淘汰**：超过 maxAgeMs（缺省 90 天）且不在保护名单的会话组删除；
 * 3. **总量封顶**：main + archive 总字节超过 maxBytes（缺省 4 GiB）时，从最老开始删
 *    （保护名单之外的），直到回落到上限内。
 *
 * **归档目录优先删除**：`archive/` 是冷存储（`SessionArchiveLayout` 的口径），同样的年龄下
 * 先删冷的、后删热的，让"最近还在用"的会话多活最久。
 *
 * ## 附件（content-addressed）只能按引用集删
 *
 * `attachments/<sha256>.<ext>` 是跨会话共享的内容寻址文件，无法按会话分组归属。判定口径：
 * 读**删除后仍存活的**全部 `.jsonl`，收集其中出现的附件文件名（引用形态是事件里的
 * `path`，内容寻址 ⇒ 子串匹配文件名即判定），未引用且超龄的删。引用扫描在读侧，
 * serve 并发写同一个文件最多让一帧引用漏扫——**年龄阈值（同 maxAgeMs）兜住这条竞态**：
 * 刚写完附件、还没落盘引用它的会话文件远 younger than 90 天，不会被当孤儿。
 *
 * ## 删除失败的语义
 *
 * Windows 下 serve 正持有的会话文件删除会 EBUSY/EPERM——**逐组 try/catch 进 skipped**，
 * 绝不让 GC 让 serve 起不来；被锁的组下一次 GC 再试。dry-run 全程不删，报告里给"将会删除"清单。
 */
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { SessionStorageLocation } from './sessionStorageLocation.ts';
import { SessionArchiveLayout } from './sessionArchiveLayout.ts';

/** GC 选项。 */
export interface SessionGcOptions {
  /** 会话主目录（缺省 `SessionStorageLocation.defaultDir()`）。 */
  readonly sessionsDir?: string | undefined;
  /** 绝不删除的最新会话组数（缺省 50）。 */
  readonly keepNewest?: number | undefined;
  /** 年龄阈值（毫秒；缺省 90 天）。 */
  readonly maxAgeMs?: number | undefined;
  /** main+archive 总字节上限（缺省 4 GiB）。 */
  readonly maxBytes?: number | undefined;
  /** 只报告不删除。 */
  readonly dryRun?: boolean | undefined;
  /** 受控时钟（测试）。 */
  readonly now?: number | undefined;
}

/** GC 报告。 */
export interface SessionGcReport {
  /** 扫描到的会话组数（main + archive）。 */
  readonly groupsScanned: number;
  /** 删除前总字节。 */
  readonly totalBytes: number;
  /** 已删/将删（dry-run）的会话组文件。 */
  readonly deletedGroups: readonly string[];
  /** 已删/将删（dry-run）的孤儿附件。 */
  readonly deletedAttachments: readonly string[];
  /** 实际释放字节（dry-run 时为"将会释放"）。 */
  readonly freedBytes: number;
  /** 删除失败（被锁/无权限）的条目。 */
  readonly skipped: readonly string[];
  /** 是否 dry-run。 */
  readonly dryRun: boolean;
}

/** 一个会话组：同一会话的 `.jsonl` 及其 sidecar（`.summary.json` 等）。 */
interface SessionGroup {
  /** 会话文件基名（如 `sess_xxx.jsonl`）。 */
  readonly base: string;
  /** 所在目录（main 或 archive）。 */
  readonly dir: string;
  /** 组内全部文件路径。 */
  readonly files: readonly string[];
  /** 组内最大 mtime（毫秒）。 */
  readonly mtimeMs: number;
  /** 组总字节。 */
  readonly bytes: number;
}

/** 会话存档 GC（纯逻辑 + 受限 IO；serve 启动 / 周期维护 / `gc` 命令共用）。 */
export class SessionGc {
  /** 缺省 keepNewest。 */
  public static readonly DEFAULT_KEEP_NEWEST = 50;
  /** 缺省年龄阈值（90 天）。 */
  public static readonly DEFAULT_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;
  /** 缺省总量上限（4 GiB）。 */
  public static readonly DEFAULT_MAX_BYTES = 4 * 1024 * 1024 * 1024;

  /**
   * 扫描并按保留策略删除。
   * @param options 目录/策略/dry-run/时钟。
   * @returns 报告。
   */
  public static run(options: SessionGcOptions = {}): SessionGcReport {
    const now = options.now ?? Date.now();
    const keepNewest = options.keepNewest ?? SessionGc.DEFAULT_KEEP_NEWEST;
    const maxAgeMs = options.maxAgeMs ?? SessionGc.DEFAULT_MAX_AGE_MS;
    const maxBytes = options.maxBytes ?? SessionGc.DEFAULT_MAX_BYTES;
    const dryRun = options.dryRun ?? false;
    const mainDir = options.sessionsDir ?? SessionStorageLocation.defaultDir();
    const archiveDir = SessionArchiveLayout.archiveDirOf(mainDir);

    const groups = SessionGc.collectGroups([mainDir, archiveDir]);
    const totalBytes = groups.reduce((sum, group) => sum + group.bytes, 0);

    // 删除顺序：归档优先，其次最老优先（SessionGroup 的收集顺序已保证 dir 顺序）。
    const ordered = [...groups].sort((a, b) => {
      if (a.dir !== b.dir) return a.dir === archiveDir ? -1 : 1;
      return a.mtimeMs - b.mtimeMs;
    });
    // keepNewest 保护按"新"排序取前 N（与删除顺序无关：保护是全局面）。
    const protectedBases = new Set(
      [...groups]
        .sort((a, b) => b.mtimeMs - a.mtimeMs)
        .slice(0, Math.max(0, keepNewest))
        .map((group) => `${group.dir}|${group.base}`),
    );

    const deletedGroups: string[] = [];
    const skipped: string[] = [];
    let freedBytes = 0;
    let remainingBytes = totalBytes;
    // 硬保护只有一条：keepNewest（最新的 N 组绝不删）。**年龄不进硬保护**——总量封顶
    // 本来就允许删"还没老到阈值"的组（否则上限永不生效，2026-10-26 判据实跑抓出）。
    const isKept = (group: SessionGroup): boolean =>
      protectedBases.has(`${group.dir}|${group.base}`);

    for (const group of ordered) {
      if (isKept(group)) continue;
      const overAge = now - group.mtimeMs >= maxAgeMs;
      const overBytes = remainingBytes > maxBytes;
      // ordered 是「最老优先」：最老的这组既不超龄、总量也未超 ⇒ 后面的只会更年轻且总量已满足，可停。
      if (!overAge && !overBytes) break;
      const error = SessionGc.deleteGroup(group, dryRun);
      if (error !== undefined) {
        skipped.push(error);
        continue;
      }
      deletedGroups.push(...group.files);
      freedBytes += group.bytes;
      remainingBytes -= group.bytes;
    }

    const deletedAttachments = SessionGc.sweepOrphanAttachments(
      [mainDir, archiveDir],
      maxAgeMs,
      dryRun,
      skipped,
    );

    return {
      groupsScanned: groups.length,
      totalBytes,
      deletedGroups,
      deletedAttachments,
      freedBytes,
      skipped,
      dryRun,
    };
  }

  /**
   * 收集两个目录里的会话组（每个 `*.jsonl` 一组，sidecar 以同基名前缀归组）。
   * @param dirs 目录列表（main 在前、archive 在后）。
   * @returns 组列表。
   */
  private static collectGroups(dirs: readonly string[]): readonly SessionGroup[] {
    const groups: SessionGroup[] = [];
    for (const dir of dirs) {
      if (!existsSync(dir)) continue;
      let names: string[];
      try {
        names = readdirSync(dir);
      } catch {
        continue;
      }
      for (const name of names) {
        if (!name.endsWith('.jsonl')) continue;
        const files: string[] = [];
        let bytes = 0;
        let mtimeMs = 0;
        for (const candidate of [name, `${name}.summary.json`]) {
          const path = join(dir, candidate);
          try {
            const stat = statSync(path);
            files.push(path);
            bytes += stat.size;
            mtimeMs = Math.max(mtimeMs, stat.mtimeMs);
          } catch {
            /* sidecar 不存在属正常 */
          }
        }
        if (files.length === 0) continue;
        groups.push({ base: name, dir, files, mtimeMs, bytes });
      }
    }
    return groups;
  }

  /**
   * 删除一个会话组（整组原子语义：任一文件失败就整组留下，避免删一半）。
   * @param group 会话组。
   * @param dryRun true 只统计不动手。
   * @returns 失败描述；成功返回 undefined。
   */
  private static deleteGroup(group: SessionGroup, dryRun: boolean): string | undefined {
    if (dryRun) return undefined;
    for (const file of group.files) {
      try {
        rmSync(file, { force: true });
      } catch (error) {
        return `会话组删除失败 ${file}: ${String(error)}`;
      }
    }
    return undefined;
  }

  /**
   * 清扫孤儿附件：未被任何存活 `.jsonl` 引用、且超过年龄阈值（**时长语义**，与 maxAgeMs 同单位）的 `attachments/*`。
   * @param dirs 会话目录列表。
   * @param maxAgeMs 年龄阈值（毫秒；早于该年龄的未引用附件才删——给"附件刚落盘、引用还没落"的竞态留窗口）。
   * @param dryRun true 只统计不动手。
   * @param skipped 失败收集器（就地追加）。
   * @returns 已删/将删的附件路径。
   */
  private static sweepOrphanAttachments(
    dirs: readonly string[],
    maxAgeMs: number,
    dryRun: boolean,
    skipped: string[],
  ): readonly string[] {
    const attachmentsDirs = dirs.map((dir) => join(dir, 'attachments'));
    const candidates: { path: string; mtimeMs: number }[] = [];
    for (const dir of attachmentsDirs) {
      if (!existsSync(dir)) continue;
      let names: string[];
      try {
        names = readdirSync(dir);
      } catch {
        continue;
      }
      for (const name of names) {
        const path = join(dir, name);
        try {
          const stat = statSync(path);
          if (stat.isFile()) candidates.push({ path, mtimeMs: stat.mtimeMs });
        } catch {
          /* 扫描期间被删：下一轮再处理 */
        }
      }
    }
    if (candidates.length === 0) return [];

    // 引用集：附件文件名以子串形式出现在任一存活事件文件里即算被引用
    // （内容寻址文件名足够独特，误判面可忽略；子串匹配避免解析 JSON 的成本与容错负担）。
    const referenced = new Set<string>();
    for (const dir of dirs) {
      if (!existsSync(dir)) continue;
      let names: string[];
      try {
        names = readdirSync(dir);
      } catch {
        continue;
      }
      for (const name of names) {
        if (!name.endsWith('.jsonl')) continue;
        let content: string;
        try {
          content = readFileSync(join(dir, name), 'utf8');
        } catch {
          continue; // 读不到（被锁/被删）就当它引用了一切之外的东西——保守，不删任何候选
        }
        for (const candidate of candidates) {
          if (referenced.has(candidate.path)) continue;
          const base = candidate.path.includes('/')
            ? candidate.path.slice(candidate.path.lastIndexOf('/') + 1)
            : candidate.path.slice(candidate.path.lastIndexOf('\\') + 1);
          if (content.includes(base)) referenced.add(candidate.path);
        }
      }
    }

    const now = Date.now();
    const deleted: string[] = [];
    for (const candidate of candidates) {
      if (referenced.has(candidate.path)) continue;
      if (now - candidate.mtimeMs < maxAgeMs) continue;
      if (!dryRun) {
        try {
          rmSync(candidate.path, { force: true });
        } catch (error) {
          skipped.push(`附件删除失败 ${candidate.path}: ${String(error)}`);
          continue;
        }
      }
      deleted.push(candidate.path);
    }
    return deleted;
  }
}
