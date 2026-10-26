import { createHash } from 'node:crypto';
import { statSync, watch, type FSWatcher } from 'node:fs';
import { join, sep } from 'node:path';
import { ContextEngine } from './contextEngine.ts';

/** IO/变更观测计数。 */
export interface CorpusWatchStats {
  /** stat 快速复用次数。 */
  readonly statReuses: number;
  /** 全量内容哈希次数。 */
  readonly fullHashes: number;
  /** 只复核变更路径即判定未变、跳过全量哈希的次数。 */
  readonly pathReuses: number;
  /** watcher 不可用/出错的回落次数。 */
  readonly watcherFallbacks: number;
}

/**
 * 语料缓存的 `fs.watch` / stat 预筛注册表（2026-10-23 从 `CorpusIndexCache` 拆出）。
 *
 * 职责只有两件：维护每 workspace 的递归 watcher，以及在 watcher 干净时提供
 * `rel:mtime:size` 的轻量 stat 签名。**正确性**仍由 `CorpusIndexCache` 的内容哈希兜底：
 * watcher 不可用或有事件时绝不单信 mtime。
 */
export class CorpusWatchRegistry {
  /** 每个 workspace 的 watcher。 */
  private readonly watchers = new Map<string, FSWatcher>();
  /** 收到变更事件、待下次复核的 workspace。 */
  private readonly dirty = new Set<string>();
  /** 待复核的**具体变更路径**（相对 POSIX）；空串表示"文件名不可用，必须全量复核"。 */
  private readonly changes = new Map<string, Set<string>>();
  /** 是否启用 watcher。 */
  private readonly enabled: boolean;
  /** 不支持递归 watch 后置位，避免重复尝试。 */
  private watchDisabled = false;
  /** 观测计数。 */
  private readonly io = { statReuses: 0, fullHashes: 0, pathReuses: 0, watcherFallbacks: 0 };

  /**
   * @param enabled 是否启用 `fs.watch`（缺省 true）。
   */
  public constructor(enabled = true) {
    this.enabled = enabled;
  }

  /** 建立 watcher（幂等；平台不支持时回落并计数）。
   * @param root 工作区根。
   * @returns 无返回值。
   */
  public ensure(root: string): void {
    if (!this.enabled || this.watchDisabled || this.watchers.has(root)) return;
    try {
      const watcher = watch(root, { recursive: true });
      const markDirty = (_event: string, filename: string | Buffer | null): void => {
        if (!CorpusWatchRegistry.watchRelevant(filename)) return;
        this.markChanged(root, filename);
      };
      watcher.on('change', markDirty);
      watcher.on('rename', markDirty);
      watcher.on('error', () => {
        this.close(root);
        this.watchDisabled = true;
        this.io.watcherFallbacks += 1;
      });
      watcher.unref();
      this.watchers.set(root, watcher);
    } catch {
      this.watchDisabled = true;
      this.io.watcherFallbacks += 1;
    }
  }

  /** 关闭并移除 watcher。
   * @param root 工作区根。
   * @returns 无返回值。
   */
  public close(root: string): void {
    const watcher = this.watchers.get(root);
    if (watcher === undefined) return;
    this.watchers.delete(root);
    this.dirty.delete(root);
    this.changes.delete(root);
    try {
      watcher.close();
    } catch {
      // 已关闭/平台差异：忽略。
    }
  }

  /** 关闭全部 watcher（宿主关停/测试用）。
   * @returns 无返回值。
   */
  public closeAll(): void {
    for (const root of [...this.watchers.keys()]) this.close(root);
  }

  /** 是否有可用 watcher。
   * @param root 工作区根。
   * @returns 可用时为 true。
   */
  public isActive(root: string): boolean {
    return this.watchers.has(root);
  }

  /** 是否有待复核事件。
   * @param root 工作区根。
   * @returns 脏时为 true。
   */
  public isDirty(root: string): boolean {
    return this.dirty.has(root);
  }

  /** 清除脏标记（内容哈希复核后调用）。
   * @param root 工作区根。
   * @returns 无返回值。
   */
  public clearDirty(root: string): void {
    this.dirty.delete(root);
    this.changes.delete(root);
  }

  /**
   * 记录一次变更（watcher 回调与测试共用入口）。
   *
   * 文件名不可用（null/空）时写入空串哨兵，表示"只知道脏、不知道哪条路径"，调用方必须全量复核。
   * @param root 工作区根。
   * @param filename watcher 给出的相对文件名。
   * @returns 无返回值。
   */
  public markChanged(root: string, filename: string | Buffer | null): void {
    this.dirty.add(root);
    const rel = CorpusWatchRegistry.normalizeChanged(filename);
    const set = this.changes.get(root) ?? new Set<string>();
    set.add(rel);
    this.changes.set(root, set);
  }

  /**
   * 取本次待复核的变更路径（相对 POSIX）。
   * @param root 工作区根。
   * @returns 路径集合；含空串哨兵或没有记录时 undefined（调用方须全量复核）。
   */
  public changedPaths(root: string): ReadonlySet<string> | undefined {
    const set = this.changes.get(root);
    if (set === undefined || set.size === 0 || set.has('')) return undefined;
    return set;
  }

  /** 记录一次 stat 快速复用。
   * @returns 无返回值。
   */
  public noteStatReuse(): void {
    this.io.statReuses += 1;
  }

  /** 记录一次全量内容哈希。
   * @returns 无返回值。
   */
  public noteFullHash(): void {
    this.io.fullHashes += 1;
  }

  /** 记录一次"只复核变更路径即未变"的复用。
   * @returns 无返回值。
   */
  public notePathReuse(): void {
    this.io.pathReuses += 1;
  }

  /** 取观测快照。
   * @returns 计数副本。
   */
  public stats(): CorpusWatchStats {
    return { ...this.io };
  }

  /**
   * 轻量 stat 签名（只 stat、不读内容）。
   * @param root 工作区根。
   * @returns 签名；枚举/stat 失败时 null。
   */
  public statSignature(root: string): string | null {
    try {
      const rels: string[] = [];
      ContextEngine.walk(root, root, rels, {
        maxFiles: ContextEngine.MAX_FILES,
        maxTotalBytes: ContextEngine.MAX_TOTAL_BYTES,
        maxFileBytes: ContextEngine.MAX_FILE_BYTES,
      });
      const parts: string[] = [];
      for (const rel of rels) {
        const info = statSync(join(root, rel.split('/').join(sep)));
        parts.push(`${rel}:${String(info.mtimeMs)}:${String(info.size)}`);
      }
      parts.sort();
      return createHash('sha1').update(parts.join('\n')).digest('hex');
    } catch {
      return null;
    }
  }

  /**
   * 事件文件名是否值得触发复核（过滤索引之外的目录）。
   * @param filename watcher 回调文件名。
   * @returns 相关时为 true；空文件名保守视为相关。
   */
  private static watchRelevant(filename: string | Buffer | null): boolean {
    if (filename === null || filename === '') return true;
    const rel = String(filename).replace(/\\/g, '/');
    return !/(^|\/)(?:node_modules|\.git|dist|target|\.cache|\.omni-storage|\.omni-checkpoints|\.tmp)(?:\/|$)/iu.test(
      rel,
    );
  }

  /**
   * 归一化 watcher 文件名：反斜杠→斜杠、去掉 `./` 前缀；不可用时返回空串哨兵。
   * @param filename watcher 回调的 filename。
   * @returns 相对 POSIX 路径或空串。
   */
  private static normalizeChanged(filename: string | Buffer | null): string {
    if (filename === null || filename === '') return '';
    return String(filename).replace(/\\/g, '/').replace(/^\.\//u, '');
  }
}
