/**
 * 语料索引缓存（CorpusIndexCache）——按 workspace 根路径缓存 light 模式索引，带 TTL 失效与 LRU 驱逐。
 *
 * 设计要点：
 *  - 单一职责：只负责「把根目录变成可查询语料并缓存」，不含任何检索/融合逻辑。
 *  - **进程级复用**：跨 step 复用同一索引，规避「agent 改文件 → 根 mtime 变 → 每步重索引」的风暴。
 *  - TTL（默认 30s，env OMNI_REPO_MAP_TTL_MS 覆盖）：超时后下次查询触发重索引。
 *  - **内容签名增量复用（2026-10 收尾项 #17；2026-10-02 由 mtime 升级为内容哈希）**：TTL 到期
 *    不再无条件全量重建，而是先比对「参与索引的文件集合 + 各自**内容哈希**」签名；未变则复用既有
 *    语料（跳过 8.6s 级全量重建），仅当文件集合或**内容真的变化**才重建。
 *  - LRU 近似驱逐：条目数超上限时淘汰**最早索引**的一条（无第三方依赖、够用），并通过构造时注入的
 *    onEvict 回调通知外部（如语义索引缓存同步失效该 root 的全部变体），保持两类缓存一致。
 *  - 全程 fail-closed：索引失败返回 null，绝不抛错崩主流程；但**不静默**——失败会记 warn 日志
 *    （带 root 与堆栈），否则调用方只看到「语料索引失败」而无法定位真因。
 *  - **两种失效语义（2026-10-03 分离）**：{@link CorpusIndexCache.clear} 硬删（必定重建），
 *    {@link CorpusIndexCache.invalidate} 软标记（下次 get 复核内容签名，未变则复用）。写类工具
 *    落盘后的默认路径走软失效——详见 `invalidate` 的实测依据。
 *  - **命中率埋点（2026-10-02）**：本类是全仓最热的缓存，却长期零命中率观测。现每次 `get`
 *    都判定命中/未命中并上报注入的 `onSample`；「TTL 内直取」与「mtime 未变复用」均计为命中，
 *    只有真正走到 `indexRoot` 才算未命中。索引失败（返回 null）**不计入样本**——它不是缓存语义，
 *    混入会低估命中率。
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import { ContextEngine, type IndexedCorpus } from './contextEngine.ts';
import { CorpusFileParser } from './corpusFileParser.ts';
import { CorpusIncrementalUpdater } from './corpusIncrementalUpdater.ts';
import type { CorpusFileArtifact } from './corpusFileArtifact.ts';
import { CorpusWatchRegistry } from './corpusWatchRegistry.ts';
import { log } from '../util/logger.ts';

/** 缓存条目：语料 + 索引时间戳 + 文件内容签名（用于 TTL 失效与内容增量复用）。 */
interface CacheEntry {
  /** 已构建的语料索引。 */
  readonly corpus: IndexedCorpus;
  /** 索引完成时刻（Date.now()）。 */
  readonly indexedAt: number;
  /** 最近一次命中时刻（空闲淘汰用）。 */
  readonly lastAccess: number;
  /**
   * 索引时各参与文件（rel 路径）与其**内容哈希**拼成的有序签名；TTL 到期时比对以决定是否复用。
   * 文件集合或任一文件内容变化 ⇒ 签名变化 ⇒ 重建。
   */
  readonly contentSig: string;
  /**
   * 逐文件 `rel:mtimeMs:size` 的轻量签名（2026-10-23）。
   *
   * 只在 `fs.watch` 可用且未收到变更事件时作为**无需读文件**的快速复核；
   * 不看 mtime 单独下结论（watcher 不可用/有事件 ⇒ 仍走内容哈希）。
   */
  readonly statSig: string;
  /**
   * 逐文件解析产物（rel → 产物），供 `CorpusIncrementalUpdater` 按内容哈希复用。
   * 生命期与本条目一致（LRU 驱逐即释放）；首次全量索引时由 `artifactSink` 写入。
   */
  readonly artifacts: ReadonlyMap<string, CorpusFileArtifact>;
  /** 估算堆占用（字节；用于 `maxBytes` 预算，不是精确 RSS）。 */
  readonly estimatedBytes: number;
}

/** 默认最多缓存的工作区数量（多 workspace 会话防内存无限增长）。 */
const DEFAULT_MAX_ENTRIES = 2;
/** 默认索引 TTL（毫秒）：超过则下次查询触发重索引。 */
const DEFAULT_TTL_MS = 30_000;
/**
 * 默认总字节预算（256 MiB）。
 *
 * 本机实测单份全仓索引约 259 MB 堆；按条数 4 条会到 ~1 GB。字节预算让「大仓只留一份、
 * 小仓可多留几份」，不再只看条数。
 */
const DEFAULT_MAX_BYTES = 256 * 1024 * 1024;
/** 默认空闲淘汰（10 分钟）：条目长时间不再被查询即释放，不等到进程退出。 */
const DEFAULT_IDLE_MS = 10 * 60_000;

/** 构造选项。 */
export interface CorpusIndexCacheOptions {
  /** 最多缓存的工作区数量；缺省 2（2026-10-23 从 4 收紧）。 */
  readonly maxEntries?: number;
  /** 估算堆占用总预算（字节）；缺省 256 MiB。单条超预算时至少保留该条。 */
  readonly maxBytes?: number;
  /** 空闲淘汰时长（毫秒）；缺省 10 分钟，`0` = 关闭空闲淘汰。 */
  readonly idleMs?: number;
  /** TTL 覆盖（毫秒；缺省 env `OMNI_REPO_MAP_TTL_MS` → 30s；测试用）。 */
  readonly ttlMs?: number;
  /** 是否启用 `fs.watch` 变更信号（缺省 true；不支持递归 watch 的平台自动回落全量哈希）。 */
  readonly watch?: boolean;
  /** 驱逐回调：某 root 被 LRU 淘汰时调用，供外部同步失效关联缓存。 */
  readonly onEvict?: (root: string) => void;
  /** 命中率上报回调：每次查询判定后调用（缺省即不统计，行为与接入前完全一致）。 */
  readonly onSample?: (hit: boolean) => void;
}

/**
 * 构造缓存条目（统一计算估算字节，避免各写入点漏算）。
 * @param corpus 语料。
 * @param artifacts 逐文件产物。
 * @param indexedAt 索引时刻。
 * @param contentSig 内容签名。
 * @param statSig 轻量 stat 签名。
 * @param lastAccess 最近访问时刻（缺省同索引时刻）。
 * @returns 缓存条目。
 */
const makeEntry = (
  corpus: IndexedCorpus,
  artifacts: ReadonlyMap<string, CorpusFileArtifact>,
  indexedAt: number,
  contentSig: string,
  statSig: string,
  lastAccess: number = indexedAt,
): CacheEntry => ({
  corpus,
  indexedAt,
  lastAccess,
  contentSig,
  statSig,
  artifacts,
  estimatedBytes: estimateBytes(corpus, artifacts),
});

/**
 * 估算条目堆占用（**近似值**，用于相对预算而非 RSS 承诺）。
 *
 * 口径：文件正文 UTF-16 字符 ×2；两套 BM25 文档 token 按 48 字节/词估算（typed 文档 +
 * packed 倒排的摊销）；artifacts 已改「单串编码」，按字符 ×2；符号节点按 128 字节/个；
 * 另加 1 MiB 固定开销。2026-10-23 压缩后实测 `src/` 63.6 MB、全仓 108.9 MB（RSS 280.8 MB），
 * 估算用于相对预算，不作为 RSS 承诺。
 * @param corpus 语料。
 * @param artifacts 逐文件产物。
 * @returns 估算字节数。
 */
const estimateBytes = (
  corpus: IndexedCorpus,
  artifacts: ReadonlyMap<string, CorpusFileArtifact>,
): number => {
  let chars = 0;
  for (const text of corpus.fileText.values()) chars += text.length;
  let artifactChars = 0;
  for (const artifact of artifacts.values()) {
    artifactChars += artifact.fileDoc.length;
    for (const doc of artifact.symbolDocs) artifactChars += doc.length;
  }
  const docTokens = corpus.symbolIndex.tokenCount + corpus.fileIndex.tokenCount;
  return 1024 * 1024 + chars * 2 + docTokens * 48 + artifactChars * 2 + corpus.symbols.length * 128;
};

/**
 * 索引 TTL（毫秒）：显式选项 > env > 默认。
 * @param override 显式 TTL（undefined = 读 env/default）。
 * @returns TTL 毫秒数。
 */
const ttlMs = (override: number | undefined): number => {
  if (override !== undefined) return override;
  const raw = Number(process.env.OMNI_REPO_MAP_TTL_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_TTL_MS;
};

/**
 * 计算某 root 下「参与索引的文件集合 + 各自内容哈希」签名。
 *
 * 用 `ContextEngine.walk`（与 `indexCorpus` 同一套忽略清单与三道上限）枚举文件，
 * 再逐个读取文件内容并哈希。签名相等 ⇒ 语料无需重建。内容哈希而非 mtime：
 * mtime 同毫秒/被保留时会假阴性，touch/git 回写时会假阳性；内容本身才是判据。
 * @param root workspace 根路径。
 * @returns `rel → sha1`；根不可枚举或任一文件不可读时返回 null。
 */
const contentHashes = (root: string): ReadonlyMap<string, string> | null => {
  try {
    const rels: string[] = [];
    ContextEngine.walk(root, root, rels, {
      maxFiles: ContextEngine.MAX_FILES,
      maxTotalBytes: ContextEngine.MAX_TOTAL_BYTES,
      maxFileBytes: ContextEngine.MAX_FILE_BYTES,
    });
    const hashes = new Map<string, string>();
    for (const rel of rels) {
      // 按原始字节哈希（不先转 utf8）：与 indexCorpus 读同一份磁盘字节。
      const bytes = readFileSync(join(root, rel.split('/').join(sep)));
      hashes.set(rel, CorpusFileParser.hashOfBytes(bytes));
    }
    return hashes;
  } catch {
    return null;
  }
};

/**
 * 由逐文件哈希表算出整体签名（`rel:hash` 排序后连接再哈希）。
 * @param hashes 逐文件哈希表。
 * @returns 内容签名串。
 */
const signatureOf = (hashes: ReadonlyMap<string, string>): string => {
  const parts: string[] = [];
  for (const [rel, digest] of hashes) parts.push(`${rel}:${digest}`);
  parts.sort();
  return createHash('sha1').update(parts.join('\n')).digest('hex');
};

/**
 * 计算某 root 的整体内容签名。
 * @param root workspace 根路径。
 * @returns 签名串；不可枚举/不可读时 null。
 */
const contentSignature = (root: string): string | null => {
  const hashes = contentHashes(root);
  return hashes === null ? null : signatureOf(hashes);
};

/**
 * 全量建索引（同时产出逐文件产物表）。
 * @param root workspace 根路径。
 * @returns 语料与产物表；失败返回 null（fail-closed）。
 */
const buildFresh = (
  root: string,
): {
  readonly corpus: IndexedCorpus;
  readonly artifacts: Map<string, CorpusFileArtifact>;
} | null => {
  const artifacts = new Map<string, CorpusFileArtifact>();
  try {
    return {
      corpus: ContextEngine.indexCorpus(root, {
        morph: true,
        light: true,
        artifactSink: artifacts,
      }),
      artifacts,
    };
  } catch (error) {
    const stack = error instanceof Error ? error.stack : undefined;
    log.warn('corpusIndexCache 索引失败（fail-closed 返回 null）', {
      root,
      error: error instanceof Error ? error.message : String(error),
      ...(stack !== undefined ? { stack } : {}),
    });
    return null;
  }
};

/**
 * 分块（可让出事件循环）的全量重建：与 `buildFresh` 同产物、同 fail-closed 语义。
 * @param root workspace 根路径。
 * @returns 语料与产物表；失败时为 null。
 */
const buildFreshAsync = async (
  root: string,
): Promise<{
  readonly corpus: IndexedCorpus;
  readonly artifacts: Map<string, CorpusFileArtifact>;
} | null> => {
  const artifacts = new Map<string, CorpusFileArtifact>();
  try {
    return {
      corpus: await ContextEngine.indexCorpusAsync(root, {
        morph: true,
        light: true,
        artifactSink: artifacts,
      }),
      artifacts,
    };
  } catch (error) {
    const stack = error instanceof Error ? error.stack : undefined;
    log.warn('corpusIndexCache 异步索引失败（fail-closed 返回 null）', {
      root,
      error: error instanceof Error ? error.message : String(error),
      ...(stack !== undefined ? { stack } : {}),
    });
    return null;
  }
};

export class CorpusIndexCache {
  /** 按 workspace 根路径缓存的语料（TTL 失效 / LRU 驱逐）。 */
  private readonly cache = new Map<string, CacheEntry>();
  /**
   * 增量重建器：TTL 到期且内容**真的**变了时，只重建变化文件的词项与 BM25 槽位。
   * 与全量路径共用 `CorpusFileParser`（解析规则单一实现），且只处理 light 档。
   */
  private readonly incremental = new CorpusIncrementalUpdater({ morph: true, light: true });
  /** 条数/字节预算（不可变；热路径只读）。 */
  private readonly limits: { readonly maxEntries: number; readonly maxBytes: number };
  /** 空闲淘汰时长（毫秒；0 = 关闭）。 */
  private readonly idleMs: number;
  /** TTL 覆盖（毫秒；undefined = 读 env/default）。 */
  private readonly ttlOverride: number | undefined;
  /** watcher/stat 观测注册表（2026-10-23 拆出，避免本类越过成员数上限）。 */
  public readonly watch: CorpusWatchRegistry;
  /** 空闲淘汰定时器（unref，不阻止进程退出）。 */
  private readonly idleTimer?: ReturnType<typeof setInterval> | undefined;
  /** 驱逐回调（可缺省）。 */
  private readonly onEvict?: ((root: string) => void) | undefined;
  /** 命中率上报回调（可缺省）。 */
  private readonly onSample?: ((hit: boolean) => void) | undefined;
  /** 命中次数（观测用）。 */
  private hits = 0;
  /** 未命中次数（观测用）。 */
  private misses = 0;

  /**
   * @param options 上限、驱逐回调与命中率上报回调（均可缺省）。
   */
  public constructor(options: CorpusIndexCacheOptions = {}) {
    this.limits = {
      maxEntries: CorpusIndexCache.positiveOr(options.maxEntries, DEFAULT_MAX_ENTRIES),
      maxBytes: CorpusIndexCache.positiveOr(options.maxBytes, DEFAULT_MAX_BYTES),
    };
    this.idleMs = CorpusIndexCache.nonNegativeOr(options.idleMs, DEFAULT_IDLE_MS);
    this.ttlOverride =
      options.ttlMs !== undefined && Number.isFinite(options.ttlMs) && options.ttlMs >= 0
        ? Math.floor(options.ttlMs)
        : undefined;
    this.watch = new CorpusWatchRegistry(options.watch !== false);
    this.onEvict = options.onEvict;
    this.onSample = options.onSample;
    if (this.idleMs > 0) {
      const timer = setInterval(
        () => {
          this.sweepIdle();
        },
        Math.min(this.idleMs, 60_000),
      );
      timer.unref();
      this.idleTimer = timer;
    }
  }

  /**
   * 释放空闲超过 `idleMs` 的条目。
   * @param now 当前时刻（缺省 Date.now；测试可注入）。
   * @returns 被释放的条目数。
   */
  public sweepIdle(now: number = Date.now()): number {
    if (this.idleMs <= 0) return 0;
    let removed = 0;
    for (const [root, entry] of [...this.cache]) {
      if (now - entry.lastAccess > this.idleMs) {
        this.cache.delete(root);
        this.watch.close(root);
        this.onEvict?.(root);
        removed += 1;
      }
    }
    return removed;
  }

  /** 当前条目估算总字节数（观测/判据用）。
   * @returns 估算字节数。
   */
  public bytesInUse(): number {
    let total = 0;
    for (const entry of this.cache.values()) total += entry.estimatedBytes;
    return total;
  }

  /** 停止空闲淘汰定时器与全部 fs.watch（测试/宿主关停用；不影响已缓存条目）。
   * @returns 无返回值。
   */
  public dispose(): void {
    if (this.idleTimer !== undefined) clearInterval(this.idleTimer);
    this.watch.closeAll();
  }

  /**
   * stat 快速复核：watcher 可用、未脏、stat 签名相同 ⇒ 复用条目且不读文件。
   * @param root 工作区根。
   * @param existing 既有条目。
   * @param now 当前时刻。
   * @returns 已复用返回 true。
   */
  private tryStatReuse(root: string, existing: CacheEntry, now: number): boolean {
    this.watch.ensure(root);
    if (!this.watch.isActive(root) || this.watch.isDirty(root)) return false;
    // 变更路径复核后写入的哨兵：watcher 干净即"自上次复核以来无变更"，无需再走 0.8s 的 stat 全树。
    if (existing.statSig === '') {
      this.watch.noteStatReuse();
      this.put(
        root,
        makeEntry(existing.corpus, existing.artifacts, now, existing.contentSig, '', now),
      );
      this.sample(true);
      return true;
    }
    const statSig = this.watch.statSignature(root);
    if (statSig === null || statSig !== existing.statSig) return false;
    this.watch.noteStatReuse();
    this.put(
      root,
      makeEntry(existing.corpus, existing.artifacts, now, existing.contentSig, statSig, now),
    );
    this.sample(true);
    return true;
  }

  /**
   * 只复核 watcher 报来的变更路径，并在内容真的变了时走**路径级增量重建**（F1，2026-10-25）。
   *
   * 做法：从既有 `artifacts` 复制一份完整 hash 表，只对变更路径重新读/哈希；未变的路径不读盘。
   * - 全部一致 ⇒ 直接复用语料（`touch`/同内容保存）；
   * - 内容变了且文件集合不变 ⇒ 交给 `CorpusIncrementalUpdater`，只重解析变化的文件；
   * - 新增/删除文件 ⇒ 增量器返回 null，方法返回 false，交回全量哈希（正确性优先）。
   * 成功后把 `statSig` 置空串哨兵：watcher 干净时无需再跑 0.8s 的 stat 全树。
   * @param root 工作区根。
   * @param existing 既有条目。
   * @param now 当前时刻。
   * @returns 复用/更新后的语料；无法路径级处理时为 null（调用方回落全量哈希）。
   */
  private tryChangedPathsReuse(
    root: string,
    existing: CacheEntry,
    now: number,
  ): IndexedCorpus | null {
    this.watch.ensure(root);
    if (!this.watch.isActive(root) || !this.watch.isDirty(root)) return null;
    const paths = this.watch.changedPaths(root);
    if (paths === undefined || paths.size === 0) return null;
    const hashes = new Map<string, string>();
    for (const [rel, artifact] of existing.artifacts) hashes.set(rel, artifact.hash);
    let changed = false;
    for (const rel of paths) {
      const artifact = existing.artifacts.get(rel);
      let bytes: Buffer;
      try {
        bytes = readFileSync(join(root, rel.split('/').join(sep)));
      } catch {
        // 删除/目录事件：让增量器判文件集合变化（它会返回 null，调用方回落全量）。
        hashes.delete(rel);
        changed = true;
        continue;
      }
      const hash = CorpusFileParser.hashOfBytes(bytes);
      if (artifact?.hash !== hash) changed = true;
      hashes.set(rel, hash);
    }
    if (!changed) {
      this.watch.notePathReuse();
      this.watch.clearDirty(root);
      this.put(
        root,
        makeEntry(existing.corpus, existing.artifacts, now, existing.contentSig, '', now),
      );
      this.sample(true);
      return existing.corpus;
    }
    const sig = signatureOf(hashes);
    const updated = this.incremental.update(root, existing.corpus, existing.artifacts, hashes);
    if (updated === null) return null;
    this.watch.notePathReuse();
    this.watch.clearDirty(root);
    this.put(root, makeEntry(updated.corpus, updated.artifacts, now, sig, '', now));
    this.sample(updated.reparsed === 0);
    return updated.corpus;
  }

  /**
   * 取（命中缓存或重索引）语料。
   * @param root workspace 根路径。
   * @returns 可查询语料；索引不可用时返回 null（fail-closed，且不计入命中率样本）。
   */
  public get(root: string): IndexedCorpus | null {
    const now = Date.now();
    this.sweepIdle(now);
    const existing = this.cache.get(root);
    if (existing !== undefined && now - existing.indexedAt < ttlMs(this.ttlOverride)) {
      this.cache.set(root, { ...existing, lastAccess: now });
      this.sample(true);
      return existing.corpus;
    }
    // stat 预筛：watcher 未脏且 stat 签名未变 ⇒ 不读内容；否则回落内容哈希。
    if (existing !== undefined && this.tryStatReuse(root, existing, now)) {
      return existing.corpus;
    }
    // watcher 脏但只有少数路径：先只复核这些路径，内容没变就不必全量哈希。
    if (existing !== undefined) {
      const reused = this.tryChangedPathsReuse(root, existing, now);
      if (reused !== null) return reused;
    }
    this.watch.clearDirty(root);
    // TTL 已过期（或首次）：用**逐文件内容哈希**判断文件集合与内容是否真的变了。
    // 若未变则直接复用既有语料（跳过 8.6s 级全量重建），并把这份哈希交给增量重建器复用，
    // 使「真的变了」的情形也不必二次读盘——见 `CorpusIncrementalUpdater`。
    if (existing !== undefined) this.watch.noteFullHash();
    const hashes = existing === undefined ? null : contentHashes(root);
    if (existing !== undefined && hashes !== null) {
      const sig = signatureOf(hashes);
      const statSig = this.watch.statSignature(root) ?? '';
      if (sig === existing.contentSig) {
        this.put(
          root,
          makeEntry(existing.corpus, existing.artifacts, now, existing.contentSig, statSig, now),
        );
        this.sample(true);
        return existing.corpus;
      }
      const updated = this.incremental.update(root, existing.corpus, existing.artifacts, hashes);
      if (updated !== null) {
        this.sample(updated.reparsed === 0);
        if (updated.reparsed === 0) {
          this.put(
            root,
            makeEntry(updated.corpus, updated.artifacts, now, existing.contentSig, statSig, now),
          );
          return updated.corpus;
        }
        this.put(root, makeEntry(updated.corpus, updated.artifacts, now, sig, statSig, now));
        return updated.corpus;
      }
    }
    const built = buildFresh(root);
    if (built === null) {
      return null;
    }
    this.sample(false);
    this.put(
      root,
      makeEntry(
        built.corpus,
        built.artifacts,
        now,
        contentSignature(root) ?? '',
        this.watch.statSignature(root) ?? '',
        now,
      ),
    );
    this.watch.ensure(root);
    return built.corpus;
  }

  /**
   * **可让出事件循环**地取语料（G8，2026-10-03）。
   *
   * ## 只接管"冷启动"这一档，其余原样委托给同步 `get`
   *
   * 全量重建是唯一超过百毫秒的同步段（本仓实测 `src/` 919 文件 ≈ **1.4 s**，期间定时器 / HTTP 回调 /
   * 日志 flush 全部阻塞）。而"已过期但内容没变"与"少量文件变化"两档走的是**内容签名比对**与
   * **增量重建**（廉价），把它们也搬到异步路径只会让墙钟变差——报告 §4 对 G8 的要求里明确写着
   * "墙钟劣化 ≤10%"，所以这里**不复制**那套决策序列（复制还会留下两份判定漂移的隐患），
   * 而是：**没有可用条目时**分块重建并写回，**其余一律**委托同步 `get`。
   *
   * ## 正确性
   *
   * 写回口径与 `buildFresh` 分支一致（同一 {@link buildFreshAsync} 产物 + 同一 `contentSignature`），
   * 故 `getAsync` 的返回与"同步 `get` 冷启动"**逐位相同**；`tests/unit/corpusIndexAsync.test.ts`
   * 对同一子树断言深度相等，并断言第二次调用命中缓存。
   * @param root workspace 根路径。
   * @returns 可查询语料；索引不可用时返回 null（fail-closed）。
   */
  public async getAsync(root: string): Promise<IndexedCorpus | null> {
    if (this.cache.get(root) !== undefined) {
      return this.get(root);
    }
    const built = await buildFreshAsync(root);
    if (built === null) {
      // 构建失败 ⇒ 交给同步路径按既有 fail-closed 语义处理（并留下同样的告警证据）。
      return this.get(root);
    }
    this.sample(false);
    const now = Date.now();
    this.put(
      root,
      makeEntry(
        built.corpus,
        built.artifacts,
        now,
        contentSignature(root) ?? '',
        this.watch.statSignature(root) ?? '',
        now,
      ),
    );
    this.watch.ensure(root);
    return built.corpus;
  }

  /**
   * 硬失效（清空条目）：下次 `get` **必定**重建，不做内容签名比对。
   *
   * 适用面：调用方**确知**语料已变或需要确定性重建（测试隔离、根目录被替换）。
   * 若只是想表达「刚跑过写类工具、请你复核一下」，用 {@link invalidate}——硬删会让
   * 「其实没变」的常见情形白付一次全量重建（本仓 902 文件实测 8.6s 量级）。
   * @param root 指定则只清该工作区；缺省清空全部。

   * @returns 无返回值。
   */
  public clear(root?: string): void {
    if (root === undefined) {
      this.cache.clear();
      this.watch.closeAll();
    } else {
      this.cache.delete(root);
      this.watch.close(root);
    }
  }

  /**
   * 软失效（标记待复核）：保留条目与**内容签名**，下次 `get` 强制走内容签名比对。
   *
   * 存在理由（2026-10-03 实测缺陷）：写类工具（`shell` / `write_file` / `edit` /
   * `apply_patch` / `checkpoint`…）落盘成功后 `StepToolExecutor.maybeInvalidateRepoMap`
   * 会失效 repo-map 缓存。此前走的是 `clear()` 硬删 ⇒ **下一次组装上下文必然全量重建**，
   * 而绝大多数写操作（`echo`、装依赖、跑测试、`git status`）根本没动被索引的源码文件。
   * 实测代价：`tests/unit/sessionLifecycle.test.ts` 一个回合内被索引**两遍**全仓
   * （8.5s + 8.5s），单文件 6 个用例耗时 100s（逼近 120s 文件级超时）。
   *
   * 软失效把「不知道变没变」如实表达为「请复核」：签名未变则复用同一语料实例
   * （下游 memo / 语义缓存因**按语料实例判失效**而一并保持有效，不会重建嵌入），
   * 签名真变则照常重建——**陈旧窗口为零**（判据是内容本身，不是时间）。
   * @param root 指定则只标记该工作区；缺省标记全部条目。

   * @returns 无返回值。
   */
  public invalidate(root?: string): void {
    if (root === undefined) {
      for (const [key, entry] of [...this.cache]) {
        this.cache.set(key, { ...entry, indexedAt: 0 });
      }
      return;
    }
    const entry = this.cache.get(root);
    if (entry !== undefined) {
      this.cache.set(root, { ...entry, indexedAt: 0 });
    }
  }

  /**
   * 命中率观测（与 `onSample` 同源的自有计数，供单测与诊断直接读取）。
   * @returns `{ hits, misses, entries }`：命中数、未命中数、当前条目数。
   */
  public stats(): { readonly hits: number; readonly misses: number; readonly entries: number } {
    return { hits: this.hits, misses: this.misses, entries: this.cache.size };
  }

  /** 上报一次命中判定（同时累加自有计数）。
   * @param hit 是否命中。
   * @returns 无返回值。
   */
  private sample(hit: boolean): void {
    if (hit) {
      this.hits += 1;
    } else {
      this.misses += 1;
    }
    this.onSample?.(hit);
  }

  /**
   * 写入条目：先按条数/字节预算淘汰最久未访问的条目，再写入。
   * @param root 工作区根。
   * @param entry 缓存条目。
   * @returns 无返回值。
   */
  private put(root: string, entry: CacheEntry): void {
    this.evictIfNeeded(entry.estimatedBytes);
    this.cache.set(root, entry);
  }

  /**
   * 按「条数 + 估算字节」淘汰最久未访问的条目（近似 LRU）。
   *
   * 单条就超过 `maxBytes` 时允许保留它（无法在不重建的前提下更小），但下一次写入会先淘汰它；
   * 这比「因为预算不够就永远不缓存」更可用，也保证最多只超一份。
   * @param incomingBytes 即将写入条目的估算字节。
   * @returns 无返回值。
   */
  private evictIfNeeded(incomingBytes: number): void {
    if (this.cache.size === 0) {
      return;
    }
    while (
      this.cache.size > 0 &&
      (this.cache.size >= this.limits.maxEntries ||
        this.bytesInUse() + incomingBytes > this.limits.maxBytes)
    ) {
      let oldestKey: string | undefined;
      let oldest = Infinity;
      for (const [key, entry] of this.cache) {
        if (entry.lastAccess < oldest) {
          oldest = entry.lastAccess;
          oldestKey = key;
        }
      }
      if (oldestKey === undefined) {
        return;
      }
      this.cache.delete(oldestKey);
      this.watch.close(oldestKey);
      this.onEvict?.(oldestKey);
    }
  }

  /** 归一化正数选项（非法/非正回落默认）。
   * @param value 输入值。
   * @param fallback 默认值。
   * @returns 正数。
   */
  private static positiveOr(value: number | undefined, fallback: number): number {
    return value !== undefined && Number.isFinite(value) && value > 0
      ? Math.floor(value)
      : fallback;
  }

  /** 归一化非负数选项（非法/负数回落默认；0 合法关闭）。
   * @param value 输入值。
   * @param fallback 默认值。
   * @returns 非负数。
   */
  private static nonNegativeOr(value: number | undefined, fallback: number): number {
    return value !== undefined && Number.isFinite(value) && value >= 0
      ? Math.floor(value)
      : fallback;
  }
}
