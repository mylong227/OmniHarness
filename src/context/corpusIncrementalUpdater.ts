import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Bm25Index } from '../search/bm25Index.js';
import { CorpusFileParser } from './corpusFileParser.js';
import type { CorpusFileArtifact } from './corpusFileArtifact.js';
import type { IndexedCorpus, IndexOptions } from './contextEngine.js';
import type { SymbolNode } from './repoMap/repoMap.js';
import { log } from '../util/logger.js';

/** 一次增量更新的产出。 */
export interface CorpusUpdate {
  /** 新语料；**内容与文件集都没变时就是 `previous` 本身**（保持对象身份 ⇒ 下游缓存不必要地失效）。 */
  readonly corpus: IndexedCorpus;
  /** 更新后的产物表（供下一次增量复用）。 */
  readonly artifacts: ReadonlyMap<string, CorpusFileArtifact>;
  /** 本次真正重新解析的文件数（0 = 文件集与内容都没变）。 */
  readonly reparsed: number;
}

/**
 * repo-map 语料的**增量重建器**（2026-10-03，`docs/PROJECT_BOARD.md` §3.1 遗留项）。
 *
 * ## 它解决什么
 *
 * 写类工具成功后语料被标记待复核；若内容**真的**变了，旧行为是全量重建（本仓实测
 * **7.2s** = 遍历 0.3s + 读盘/分词/抽符号 3.9s + BM25 建索引 3.0s），而一次编辑通常只动
 * 一两个文件。本类把三段成本各降一档：
 *
 *  1. **读盘**：内容哈希仍由上层（`CorpusIndexCache` 的签名复核）读过一遍，本类**直接复用那份
 *     逐文件哈希**，只对真的变了的文件再读一次（省 ~1.4s，且不再二次遍历）；
 *  2. **分词 / 抽符号**：按内容哈希复用产物，未变文件零重复解析（省 ~2.5s）；
 *  3. **BM25 建索引**：`Bm25Index.setDocument` 就地替换变化文件的槽位（省 ~2.2s 文件索引）。
 *
 * 净效果（本仓实测，见 `docs/PROJECT_BOARD.md` §3.1）：单文件改动后 7.2s → **约 0.05s**
 * （读盘成本已由上层签名复核承担；合计每步 8.6s → 约 1.5s）。
 *
 * ## 何时**不**增量（宁可慢，不可错）
 *
 *  - 文件**集合**与上次不一致（新增 / 删除 / 重命名 / 触到上限）⇒ `null` + 全量重建。
 *    理由：文件槽位必须与 `corpus.files` 下标一一对应，集合一变就要整体重排，前提不成立。
 *  - 缺少上次的**产物表**：没有产物就得逐文件重解析，而「逐文件 setDocument」与
 *    `addDocuments` 同阶 ⇒ 增量只会更慢（多一层簿记）。故直接 `null`。
 *  - `light !== true`（full 模式）：频域谱 / 代码图 / LSA 与符号下标强耦合，且只服务评测脚本
 *    （生产恒 light）⇒ 不做增量。
 *  - 任一变了的文件读不到 ⇒ `null`（全量路径对不可读文件是「跳过」，不在此重实现该语义，
 *    免得两条路径对同一坏文件给出不同结论）。
 *
 * ## 别名风险（如实登记）
 *
 * 增量路径**复用并就地更新** `previous.symbolIndex` / `previous.fileIndex`（复制是 O(语料)，
 * 等于没省）。更新全程**同步**（无 await 插入）⇒ 不存在「读到半更新索引」的窗口；返回的新语料
 * 与旧对象共享这两个实例，而旧对象在调用方（`CorpusIndexCache`）被整条替换、不再对外返回。
 * 下游缓存均以**语料对象身份**判失效（`RepoMapMemo` 比引用、`SemanticIndexCache` 用 WeakMap
 * 记身份）⇒ 不会命中旧语料的结果。
 */
export class CorpusIncrementalUpdater {
  /** 单文件解析器（与全量索引共用同一实现，杜绝两套口径漂移）。 */
  private readonly parser: CorpusFileParser;
  /** BM25 构造参数（与全量索引同一来源）。 */
  private readonly bm25Init: { k1?: number; b?: number };

  /**
   * @param opts 索引选项（只读 `morph` / `light` / `bm25K1` / `bm25B`）。
   */
  public constructor(private readonly opts: IndexOptions = {}) {
    this.parser = new CorpusFileParser(opts.morph !== false);
    this.bm25Init = {
      ...(opts.bm25K1 !== undefined ? { k1: opts.bm25K1 } : {}),
      ...(opts.bm25B !== undefined ? { b: opts.bm25B } : {}),
    };
  }

  /**
   * 尝试增量更新语料。
   * @param root 工作区根（绝对路径）。
   * @param previous 上一次的语料（缺省 / 非 light ⇒ 不增量）。
   * @param artifacts 上一次的产物表（缺省 ⇒ 不增量）。
   * @param hashes 本次遍历得到的**逐文件字节哈希**（rel → sha1；由上层签名复核产出，避免二次读盘）。
   * @returns 更新结果；不可增量时返回 `null`（调用方回落 `ContextEngine.indexCorpus`）。
   */
  public update(
    root: string,
    previous: IndexedCorpus | undefined,
    artifacts: ReadonlyMap<string, CorpusFileArtifact> | undefined,
    hashes: ReadonlyMap<string, string>,
  ): CorpusUpdate | null {
    if (previous === undefined || artifacts === undefined || this.opts.light === false) {
      return null;
    }
    if (!CorpusIncrementalUpdater.sameFileSet(previous, hashes)) {
      return null;
    }
    const next = new Map<string, CorpusFileArtifact>();
    const fileText = new Map<string, string>();
    let symbolStart = 0;
    let reparsed = 0;
    let symbolSlotsStable = true;
    // 槽位沿用 `previous.files` 的顺序（集合相同 ⇒ 与全量重建的文件下标一一对应）。
    for (const record of previous.files) {
      const rel = record.rel;
      const cached = artifacts.get(rel);
      const hash = hashes.get(rel);
      const text = previous.fileText.get(rel);
      if (
        cached !== undefined &&
        hash !== undefined &&
        cached.hash === hash &&
        text !== undefined
      ) {
        next.set(rel, { ...cached, symbolStart });
        fileText.set(rel, text);
        symbolStart += cached.symbols.length;
        continue;
      }
      let fresh: string;
      try {
        fresh = readFileSync(join(root, rel), 'utf8');
      } catch {
        // 全量路径对不可读文件是「跳过」；不在此重实现该语义，交回全量路径（两条路径必须同结论）。
        return null;
      }
      if (hash === undefined) {
        // `sameFileSet` 已保证不会走到这里；真走到说明哈希表与语料不同源，宁可全量重建。
        return null;
      }
      reparsed += 1;
      const artifact = this.parser.artifact(rel, fresh, symbolStart, hash);
      if (cached === undefined || cached.symbols.length !== artifact.symbols.length) {
        // 无产物基线 / 符号数变了 ⇒ 无法保证符号槽位稳定，符号索引整体重建（见类 JSDoc）。
        symbolSlotsStable = false;
      } else {
        this.applySymbolSlots(previous.symbolIndex, symbolStart, artifact);
      }
      previous.fileIndex.setDocument(next.size, artifact.fileDoc);
      fileText.set(rel, fresh);
      symbolStart += artifact.symbols.length;
      next.set(rel, artifact);
    }
    if (reparsed === 0) {
      // 文件集与内容都没变 ⇒ 直接沿用旧语料**对象**（身份不变 ⇒ memo / 语义缓存不必失效）。
      return { corpus: previous, artifacts: next, reparsed };
    }
    log.debug('corpus.incremental.update', {
      files: previous.files.length,
      reparsed,
      symbolSlotsStable,
    });
    return {
      corpus: this.assemble(root, previous, next, fileText, symbolSlotsStable),
      artifacts: next,
      reparsed,
    };
  }

  /**
   * 文件**集合**是否与上次完全一致（顺序不参与判定：槽位按 `previous.files` 沿用）。
   * @param previous 上次语料。
   * @param hashes 本次遍历得到的逐文件哈希表。
   * @returns 集合一致时为 true。
   */
  private static sameFileSet(
    previous: IndexedCorpus,
    hashes: ReadonlyMap<string, string>,
  ): boolean {
    if (previous.files.length !== hashes.size) {
      return false;
    }
    for (const record of previous.files) {
      if (!hashes.has(record.rel)) {
        return false;
      }
    }
    return true;
  }

  /** 就地更新某文件每个符号的 BM25 槽位（仅在符号数不变、槽位稳定时调用）。
   * @param symbolIndex 上次语料的符号索引（就地更新）。
   * @param start 该文件首个符号的下标。
   * @param artifact 该文件的新产物。
   * @returns 无返回值。
   */
  private applySymbolSlots(
    symbolIndex: Bm25Index,
    start: number,
    artifact: CorpusFileArtifact,
  ): void {
    for (let i = 0; i < artifact.symbolDocs.length; i += 1) {
      symbolIndex.setDocument(start + i, artifact.symbolDocs[i] ?? []);
    }
  }

  /**
   * 组装新语料对象（复用 `previous` 的索引实例与 light 档占位件）。
   * @param root 工作区根。
   * @param previous 上次语料（提供文件顺序与可复用件）。
   * @param artifacts 本次产物表。
   * @param fileText 本次正文表（未变文件直接引用上次的字符串，省一次分配）。
   * @param symbolSlotsStable 符号槽位是否全部稳定（false ⇒ 符号索引整体重建）。
   * @returns 新的 `IndexedCorpus`。
   */
  private assemble(
    root: string,
    previous: IndexedCorpus,
    artifacts: ReadonlyMap<string, CorpusFileArtifact>,
    fileText: ReadonlyMap<string, string>,
    symbolSlotsStable: boolean,
  ): IndexedCorpus {
    const files: { rel: string; tokens: number }[] = [];
    const symbols: SymbolNode[] = [];
    const symbolDocs: string[][] = [];
    for (const record of previous.files) {
      const artifact = artifacts.get(record.rel);
      if (artifact === undefined) {
        continue;
      }
      files.push({ rel: record.rel, tokens: artifact.tokenCount });
      for (const symbol of artifact.symbols) {
        symbols.push(symbol);
      }
      for (const doc of artifact.symbolDocs) {
        symbolDocs.push([...doc]);
      }
    }
    const reusable = symbolSlotsStable && previous.symbolIndex.slotCount === symbolDocs.length;
    return {
      root,
      morph: previous.morph,
      symbols,
      files,
      symbolIndex: reusable
        ? previous.symbolIndex
        : CorpusIncrementalUpdater.rebuildSymbolIndex(this.bm25Init, symbolDocs),
      fileIndex: previous.fileIndex,
      // light 档（本类只处理该档）下这三项在 `indexCorpus` 里就是空数组 / 占位常量，直接沿用。
      symbolSpectra: previous.symbolSpectra,
      fileText: new Map(fileText),
      codeGraph: previous.codeGraph,
      // 文件集未变 ⇒ 截断与超大文件计数按上次沿用（集合或大小真变时 `sameFileSet` 已判否）。
      truncated: previous.truncated,
      skippedLargeFiles: previous.skippedLargeFiles,
    };
  }

  /** 重建符号级 BM25 索引（符号数变化时用；本仓实测 ~0.8s，仍远低于全量重建的 3.0s）。
   * @param init 构造参数。
   * @param symbolDocs 全部符号文档词项。
   * @returns 新建的索引。
   */
  private static rebuildSymbolIndex(
    init: { k1?: number; b?: number },
    symbolDocs: readonly (readonly string[])[],
  ): Bm25Index {
    const index = new Bm25Index(init);
    index.addDocuments(symbolDocs);
    return index;
  }
}
