/**
 * 临时目录清扫器（2026-10-22）。
 *
 * 本仓会产生多类临时目录/文件：Chrome user-data、worktree 隔离副本、A/B 运行目录、
 * 运行清单/信任测试夹具、Laya 请求 JSON。正常路径各自 `close/finally` 清理；但进程被强杀、
 * 容器重启、跨分区 rename 中断时会留下孤儿。这里只清**本仓前缀 + 超过阈值年龄**的条目：
 * - 不碰非本仓文件；
 * - 不碰 fresher than threshold（可能是另一个正在运行的进程）；
 * - 符号链接一律跳过（避免 rmSync 跟随到工作区外）。
 */
import { lstatSync, readdirSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** 一条候选条目。 */
export interface TmpEntry {
  /** 条目名。 */
  readonly name: string;
  /** 绝对路径。 */
  readonly path: string;
  /** 修改时间（毫秒）。 */
  readonly mtimeMs: number;
  /** 是否目录。 */
  readonly directory: boolean;
}

/** 清扫选项。 */
export interface TmpSweepOptions {
  /** 临时根目录（缺省 os.tmpdir）。 */
  readonly tmpDir?: string | undefined;
  /** 年龄阈值（毫秒；缺省 24h）。 */
  readonly olderThanMs?: number | undefined;
  /** 只报告不删除。 */
  readonly dryRun?: boolean | undefined;
  /** 受控时钟（测试）。 */
  readonly now?: number | undefined;
  /** 允许的前缀（测试可覆盖）。 */
  readonly prefixes?: readonly string[] | undefined;
}

/** 清扫报告。 */
export interface TmpSweepReport {
  /** 扫描到的条目数。 */
  readonly scanned: number;
  /** 命中前缀且超龄的条目（将被/已被删除）。 */
  readonly matched: readonly string[];
  /** 实际删除数。 */
  readonly removed: number;
  /** 跳过（符号链接/删除失败）。 */
  readonly skipped: readonly string[];
  /** 是否 dry-run。 */
  readonly dryRun: boolean;
  /** 错误（不吞：调用方决定打印/上报）。 */
  readonly errors: readonly string[];
}

/**
 * 临时目录清扫器（纯逻辑 + 受限 IO）。
 */
export class TmpSweep {
  /**
   * 缺省前缀（本仓命名空间：**家族前缀**，不再逐个枚举变体）。
   *
   * 为什么从"精确枚举"改成家族前缀（2026-10-26 磁盘爆炸实测教训）：枚举表只登记了 6 个前缀，
   * 而 web 真浏览器 e2e/探针各自手写了 `omni-cdp-`、`omni-crash-`、`omni-e2e-ud-`、
   * `omni-qask-ud-`……十余个变体——漏登记的那两个就泄了 10.3 GB。变体还会继续新增，
   * 枚举永远追不齐；`omni-*` 是本仓独占的命名空间（本机 Temp 实测无其它应用使用），
   * 加上 24h 年龄阈值与"只删本仓产物"的既有纪律，家族前缀是既有安全面的真子集收窄。
   */
  public static readonly DEFAULT_PREFIXES: readonly string[] = [
    'omni-',
    'omniharness-',
    'laya-req-',
  ];

  /** 缺省年龄阈值（24h）。 */
  private static readonly DEFAULT_AGE_MS = 24 * 60 * 60 * 1000;

  /**
   * 从条目列表中选出可清理项（纯函数，便于判据）。
   * @param entries 候选条目。
   * @param now 当前时间。
   * @param olderThanMs 年龄阈值。
   * @param prefixes 允许前缀。
   * @returns 命中条目。
   */
  public static select(
    entries: readonly TmpEntry[],
    now: number,
    olderThanMs: number,
    prefixes: readonly string[] = TmpSweep.DEFAULT_PREFIXES,
  ): readonly TmpEntry[] {
    return entries.filter(
      (entry) =>
        prefixes.some((prefix) => entry.name.startsWith(prefix)) &&
        now - entry.mtimeMs >= olderThanMs,
    );
  }

  /**
   * 扫描并清理。
   * @param options 根目录/阈值/dry-run。
   * @returns 报告。
   */
  public static run(options: TmpSweepOptions = {}): TmpSweepReport {
    const root = options.tmpDir ?? tmpdir();
    const now = options.now ?? Date.now();
    const olderThanMs = options.olderThanMs ?? TmpSweep.DEFAULT_AGE_MS;
    const dryRun = options.dryRun ?? false;
    const prefixes = options.prefixes ?? TmpSweep.DEFAULT_PREFIXES;
    const entries: TmpEntry[] = [];
    const errors: string[] = [];
    const skipped: string[] = [];
    let names: string[];
    try {
      names = readdirSync(root);
    } catch (error) {
      return {
        scanned: 0,
        matched: [],
        removed: 0,
        skipped: [],
        dryRun,
        errors: [`无法读取临时目录 ${root}: ${String(error)}`],
      };
    }
    for (const name of names) {
      const path = join(root, name);
      try {
        const stat = lstatSync(path);
        if (stat.isSymbolicLink()) {
          skipped.push(path);
          continue;
        }
        entries.push({
          name,
          path,
          mtimeMs: stat.mtimeMs,
          directory: stat.isDirectory(),
        });
      } catch {
        // 条目在扫描期间被删/无权限：下一次再处理，不当作错误。
      }
    }
    const matched = TmpSweep.select(entries, now, olderThanMs, prefixes);
    let removed = 0;
    if (!dryRun) {
      for (const entry of matched) {
        try {
          if (entry.directory) {
            rmSync(entry.path, { recursive: true, force: true, maxRetries: 3 });
          } else {
            unlinkSync(entry.path);
          }
          removed += 1;
        } catch (error) {
          // 扫描后条目被别人删掉：目标状态已达成，不算失败，也不让 CLI 非零退出。
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            removed += 1;
            continue;
          }
          skipped.push(entry.path);
          errors.push(`删除失败 ${entry.path}: ${String(error)}`);
        }
      }
    }
    return {
      scanned: entries.length,
      matched: matched.map((entry) => entry.path),
      removed,
      skipped,
      dryRun,
      errors,
    };
  }
}
