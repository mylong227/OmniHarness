/**
 * 语料索引缓存（CorpusIndexCache）——按 workspace 根路径缓存 light 模式索引，带 TTL 失效与 LRU 驱逐。
 *
 * 设计要点：
 *  - 单一职责：只负责「把根目录变成可查询语料并缓存」，不含任何检索/融合逻辑。
 *  - **进程级复用**：跨 step 复用同一索引，规避「agent 改文件 → 根 mtime 变 → 每步重索引」的风暴。
 *  - TTL（默认 30s，env OMNI_REPO_MAP_TTL_MS 覆盖）：超时后下次查询触发重索引。
 *  - LRU 近似驱逐：条目数超上限时淘汰**最早索引**的一条（零依赖、够用），并通过构造时注入的
 *    onEvict 回调通知外部（如语义索引缓存同步失效该 root 的全部变体），保持两类缓存一致。
 *  - 全程 fail-closed：索引失败返回 null，绝不抛错崩主流程。
 */

import { indexCorpus, type IndexedCorpus } from './contextEngine.js';

/** 缓存条目：语料 + 索引时间戳（用于 TTL 失效与 LRU 驱逐）。 */
interface CacheEntry {
  /** 已构建的语料索引。 */
  readonly corpus: IndexedCorpus;
  /** 索引完成时刻（Date.now()）。 */
  readonly indexedAt: number;
}

/** 默认最多缓存的工作区数量（多 workspace 会话防内存无限增长）。 */
const DEFAULT_MAX_ENTRIES = 4;
/** 默认索引 TTL（毫秒）：超过则下次查询触发重索引。 */
const DEFAULT_TTL_MS = 30_000;

/** 构造选项。 */
export interface CorpusIndexCacheOptions {
  /** 最多缓存的工作区数量；缺省 4。 */
  readonly maxEntries?: number;
  /** 驱逐回调：某 root 被 LRU 淘汰时调用，供外部同步失效关联缓存。 */
  readonly onEvict?: (root: string) => void;
}

export class CorpusIndexCache {
  /** 按 workspace 根路径缓存的语料（TTL 失效 / LRU 驱逐）。 */
  private readonly cache = new Map<string, CacheEntry>();
  /** 缓存条目上限。 */
  private readonly maxEntries: number;
  /** 驱逐回调（可缺省）。 */
  private readonly onEvict?: ((root: string) => void) | undefined;

  /**
   * @param options 上限与驱逐回调（均可缺省）。
   */
  public constructor(options: CorpusIndexCacheOptions = {}) {
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.onEvict = options.onEvict;
  }

  /**
   * 取（命中缓存或重索引）语料。
   * @param root workspace 根路径。
   * @returns 可查询语料；索引不可用时返回 null（fail-closed）。
   */
  public get(root: string): IndexedCorpus | null {
    const now = Date.now();
    const existing = this.cache.get(root);
    if (existing !== undefined && now - existing.indexedAt < this.ttlMs()) {
      return existing.corpus;
    }
    const corpus = this.indexRoot(root);
    if (corpus === null) {
      return null;
    }
    this.evictIfNeeded();
    this.cache.set(root, { corpus, indexedAt: now });
    return corpus;
  }

  /**
   * 失效缓存。
   * @param root 指定则只失效该工作区；缺省清空全部。
   
 * @returns 无返回值。
*/
  public clear(root?: string): void {
    if (root === undefined) {
      this.cache.clear();
    } else {
      this.cache.delete(root);
    }
  }

  /** 索引 TTL（毫秒）：env OMNI_REPO_MAP_TTL_MS 覆盖，非法值回落默认。 */
  private ttlMs(): number {
    const raw = Number(process.env.OMNI_REPO_MAP_TTL_MS);
    return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_TTL_MS;
  }

  /**
   * 索引单个根目录（light 模式）。
   * @param root workspace 根路径。
   * @returns 语料；失败返回 null（fail-closed）。
   */
  private indexRoot(root: string): IndexedCorpus | null {
    try {
      return indexCorpus(root, { morph: true, light: true });
    } catch {
      return null;
    }
  }

  /** 条目数达上限时淘汰最早索引的一条（近似 LRU），并通知驱逐回调。
   * @returns 无返回值。
   */
  private evictIfNeeded(): void {
    if (this.cache.size < this.maxEntries) {
      return;
    }
    let oldestKey: string | undefined;
    let oldest = Infinity;
    for (const [key, entry] of this.cache) {
      if (entry.indexedAt < oldest) {
        oldest = entry.indexedAt;
        oldestKey = key;
      }
    }
    if (oldestKey !== undefined) {
      this.cache.delete(oldestKey);
      this.onEvict?.(oldestKey);
    }
  }
}
