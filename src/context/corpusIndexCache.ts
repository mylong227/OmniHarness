/**
 * 语料索引缓存（CorpusIndexCache）——按 workspace 根路径缓存 light 模式索引，带 TTL 失效与 LRU 驱逐。
 *
 * 设计要点：
 *  - 单一职责：只负责「把根目录变成可查询语料并缓存」，不含任何检索/融合逻辑。
 *  - **进程级复用**：跨 step 复用同一索引，规避「agent 改文件 → 根 mtime 变 → 每步重索引」的风暴。
 *  - TTL（默认 30s，env OMNI_REPO_MAP_TTL_MS 覆盖）：超时后下次查询触发重索引。
 *  - **mtime 增量复用（2026-10 收尾项 #17）**：TTL 到期不再无条件全量重建，而是先比对文件 mtime
 *    签名；未变则复用既有语料（跳过 8.6s 级全量重建），仅当文件集合 / mtime 真的变化才重建。
 *  - LRU 近似驱逐：条目数超上限时淘汰**最早索引**的一条（无第三方依赖、够用），并通过构造时注入的
 *    onEvict 回调通知外部（如语义索引缓存同步失效该 root 的全部变体），保持两类缓存一致。
 *  - 全程 fail-closed：索引失败返回 null，绝不抛错崩主流程；但**不静默**——失败会记 warn 日志
 *    （带 root 与堆栈），否则调用方只看到「语料索引失败」而无法定位真因。
 */

import { statSync } from 'node:fs';
import { join, sep } from 'node:path';
import { ContextEngine, type IndexedCorpus } from './contextEngine.js';
import { log } from '../util/logger.js';

/** 缓存条目：语料 + 索引时间戳 + 文件 mtime 签名（用于 TTL 失效与 mtime 增量复用）。 */
interface CacheEntry {
  /** 已构建的语料索引。 */
  readonly corpus: IndexedCorpus;
  /** 索引完成时刻（Date.now()）。 */
  readonly indexedAt: number;
  /** 索引时各参与文件（rel 路径）与其 mtimeMs 拼成的有序签名；TTL 到期时比对以决定是否复用。 */
  readonly mtimeSig: string;
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
    // TTL 已过期（或首次）：先用 mtime 签名判断文件集合是否真的变了。
    // 若未变则直接复用既有语料，跳过 8.6s 级全量重建——这是把「每 30s 一次全量重建」
    // 改为「按 mtime 增量」的核心：TTL 仅作兜底，文件真变才重建（见 `mtimeSignature`）。
    if (existing !== undefined) {
      const sig = this.mtimeSignature(root);
      if (sig !== null && sig === existing.mtimeSig) {
        this.cache.set(root, {
          corpus: existing.corpus,
          indexedAt: now,
          mtimeSig: existing.mtimeSig,
        });
        return existing.corpus;
      }
    }
    const corpus = this.indexRoot(root);
    if (corpus === null) {
      return null;
    }
    const sig = this.mtimeSignature(root) ?? '';
    this.evictIfNeeded();
    this.cache.set(root, { corpus, indexedAt: now, mtimeSig: sig });
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
   * 计算某 root 下「参与索引的文件集合 + 各自 mtime」签名。
   *
   * 用 {@link ContextEngine.walk}（与 `indexCorpus` 同一套忽略清单与三道上限）枚举文件，
   * 再逐文件取 mtimeMs 拼成有序字符串。签名相等 ⇒ 语料无需重建。
   * @param root workspace 根路径。
   * @returns 签名串；根不可枚举（坏路径 / 权限）时返回 null（调用方据此退化为全量重建）。
   */
  private mtimeSignature(root: string): string | null {
    try {
      const rels: string[] = [];
      ContextEngine.walk(root, root, rels, {
        maxFiles: ContextEngine.MAX_FILES,
        maxTotalBytes: ContextEngine.MAX_TOTAL_BYTES,
        maxFileBytes: ContextEngine.MAX_FILE_BYTES,
      });
      const parts: string[] = [];
      for (const rel of rels) {
        const abs = join(root, rel.split('/').join(sep));
        const st = statSync(abs);
        parts.push(`${rel}:${String(st.mtimeMs)}`);
      }
      parts.sort();
      return parts.join('\n');
    } catch {
      return null;
    }
  }

  /**
   * 索引单个根目录（light 模式）。
   * @param root workspace 根路径。
   * @returns 语料；失败返回 null（fail-closed）。
   */
  private indexRoot(root: string): IndexedCorpus | null {
    try {
      return ContextEngine.indexCorpus(root, { morph: true, light: true });
    } catch (error) {
      // 保持 fail-closed（返回 null 不抛），但必须留下可定位的证据：
      // 2026-09-17 batch_next 25/25「语料索引失败」曾因这里的静默 catch 而把真因
      // （worktree 未物化 → ENOENT）吞成 null，排查成本极高。
      const stack = error instanceof Error ? error.stack : undefined;
      log.warn('corpusIndexCache 索引失败（fail-closed 返回 null）', {
        root,
        error: error instanceof Error ? error.message : String(error),
        ...(stack !== undefined ? { stack } : {}),
      });
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
