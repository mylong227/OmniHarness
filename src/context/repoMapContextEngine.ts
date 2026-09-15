/**
 * repo-map 生产接入器（U2）：把已实测的上下文引擎接到真实 agent 循环。
 *
 * 设计要点：
 *  - 进程级按 workspace 根路径缓存索引，避免每个 step 重扫全仓；TTL 默认 30s，任一时段至多一次重索引，
 *    规避「agent 改文件 → 根 mtime 变 → 每步重索引」的风暴。（缓存职责在 `CorpusIndexCache`）
 *  - 任何异常（坏路径 / 空仓 / 索引失败 / 查询失败 / 禁用）→ 返回 null，绝不抛错崩 agent。
 *  - 索引强制 light 模式：仅 morph + 符号/文件双 BM25，跳过频域共振 / 44 万边代码图 / LSA SVD
 *    （三项在 omniharness 语料实测均零增益）。召回配置即基准里 67.0% 那档。
 *  - **两阶段检索（打磨第二批 P1）**：纯 BM25 路径在第一段之后可追加**零依赖词法精排**
 *    （`FileReranker`：符号名 IDF 加权覆盖率 + 第一段倒数秩）。**默认关（opt-in）**：
 *    fileK=14 档两关全过（召回 31.4%→41.0%，CI95 [1.80, 18.60]pp，留出折 38/40 为正），
 *    但 fileK=10（本入口默认预算）档 CI 下界 −0.45pp 跨 0 ⇒ 未过阈值，故不翻默认。
 *    开启：`opts.rerank` / env `OMNI_RERANK=1`。混合（语义）路径未接第二段——语义路需
 *    嵌入模型，离线无法度量，按「不报未测数字」纪律**留给可测时再定**。
 *
 * 混合检索（语义召回，U3 残留的词法盲区补强）：
 *  - `getRepoMapContext` 保持同步、纯 BM25（零破坏、既有测试不变）。
 *  - `getHybridRepoMapContext` 在传入 EmbeddingPort 时启用：BM25 命中 ∪ 语义向量召回，
 *    经 RRF 融合后产出上下文。模型缺失/离线/嵌入抛错 → 回落纯 BM25（fail-closed）。
 *  - 默认关：仅当运行时注入 embedding（env OMNI_SEMANTIC_RECALL=1 构造适配器）才走混合路径，
 *    不增 config schema，也避免默认加载 80MB 模型拖累每个 step。
 *
 * 架构（OOP 收敛，2026-09-11）：本类现为**薄编排门面**，把四类职责委派给独立协作者（各有专属文件、
 * 文件名=类名）——`RecallKnobs`（旋钮解析）/ `CorpusIndexCache`（语料缓存）/ `SemanticIndexCache`
 * （语义索引构建与缓存）/ `HybridRanker`（RRF 融合排序）。本类只负责「取语料 → 取旋钮 → 取索引 →
 * 检索 → 交给 ranker → 格式化」的编排，职责单一、易测易维护。
 * 为不触碰热区文件 `src/core/stepRunner.ts`（Agent Loop V2 会话活跃）的调用点，仍导出同名函数作为
 * 单例 `repoMapContextEngine` 的薄包装；新调用方应直接用引擎实例。
 */

import { query, type IndexedCorpus } from './contextEngine.js';
import { outlineText } from './repoMap.js';
import { tokenize, tokenizeExpanded } from '../search/bm25Index.js';
import type { RecallItem } from './semanticIndex.js';
import { clearGraphSignal } from './codeReferenceGraph.js';
import type { EmbeddingPort } from '../ports/model/embedding.js';
import { RecallKnobs, type RepoMapContextOptions } from './recallKnobs.js';
import { CorpusIndexCache } from './corpusIndexCache.js';
import { SemanticIndexCache } from './semanticIndexCache.js';
import { HybridRanker, type RankedRepoMap } from './hybridRanker.js';

// 公开符号再导出（保持原 `repoMapContext.ts` 的对外 API 表面不变）。
export type { RepoMapContextOptions } from './recallKnobs.js';
export { CHUNK_BODY_MAX_LINES } from './semanticIndexCache.js';

/** BM25 检索的候选数：符号路 / 文件路各取多少再交给融合。 */
const BM25_SYM_CANDIDATES = 60;
/** BM25 文件路候选数。 */
const BM25_FILE_CANDIDATES = 20;
/** 语义路单次召回的候选数。 */
const SEMANTIC_CANDIDATES = 40;
/** 纯 BM25 路径（getRepoMapContext）的候选数。 */
const BM25_ONLY_CANDIDATES = 20;

/**
 * repo-map 检索引擎——混合检索的编排门面（Facade）。
 *
 * 组合根：构造时装配 `CorpusIndexCache` / `SemanticIndexCache` / `HybridRanker` 三个协作者，
 * 并把「语料缓存驱逐」与「语义缓存失效」通过回调解耦地连起来。进程级共享单例见文件底部。
 */
export class RepoMapContextEngine {
  /** 语义索引缓存（先于 corpusCache 构造，供其驱逐回调引用）。 */
  private readonly semanticCache = new SemanticIndexCache();
  /**
   * 语料索引缓存；某 root 被 LRU 驱逐时，同步失效该 root 的语义索引（避免陈旧索引残留）。
   * 注：旧实现用 `semanticCache.delete(root)` 因键不匹配实为空操作，此处经回调修正为按 root 全变体失效。
   */
  private readonly corpusCache = new CorpusIndexCache({
    onEvict: (root) => this.semanticCache.clear(root),
  });
  /** 多路召回融合排序器（无状态，可复用）。 */
  private readonly ranker = new HybridRanker();

  /**
   * 产出可注入 system 消息的 repo-map 上下文文本（纯 BM25，同步、零破坏）。
   * 任意失败路径均返回 null（调用方据此跳过注入，不影响主流程）。
   * @param root workspace 根路径。
   * @param q 查询文本。
   * @param opts 选项（enabled=false 直接跳过）。
   * @returns 上下文文本，或 null（禁用 / 空查询 / 索引失败）。
   */
  public getRepoMapContext(
    root: string,
    q: string,
    opts: RepoMapContextOptions = {},
  ): string | null {
    if (opts.enabled === false) {
      return null;
    }
    if (root === undefined || root === '' || q.trim() === '') {
      return null;
    }
    const corpus = this.corpusCache.get(root);
    if (corpus === null) {
      return null;
    }
    try {
      const res = query(corpus, q, BM25_ONLY_CANDIDATES, {
        prf: false,
        graph: false,
        lsa: false,
        layered: opts.layered === true,
        fileK: opts.fileK ?? 10,
        symK: opts.symK ?? 24,
        // 第二段零依赖词法重排（打磨第二批 P1）：**默认关（opt-in）**。
        // 两关结果（`evals/rerank-ab.mjs`，真实 src/ 语料 32 条锚点查询）：
        //   · fileK=14（本仓库既有检索评测的范式口径）：31.4%→41.0% 召回（+9.6pp），
        //     CI95 [1.80, 18.60]pp **不跨 0**、留出折 38/40 为正、否决器 proceed ⇒ **两关全过**；
        //   · fileK=10（本生产入口当前的默认预算）：26.9%→33.2%（+6.3pp），
        //     CI95 [−0.45, 14.74]pp **下界跨 0**、留出折 37/40 为正（3 折为负）⇒ **未过**。
        // 生产预算档未过阈值，故**不翻默认**（本仓库纪律：两关未达标前不破生产口径）。
        // 开启：`opts.rerank = true` 或 env `OMNI_RERANK=1`；显式 `false` / `OMNI_RERANK=0` 关闭
        // （用 ?? 而非 ||：false 是合法显式值）。
        rerank: opts.rerank ?? process.env.OMNI_RERANK === '1',
      });
      return res.context;
    } catch {
      return null;
    }
  }

  /**
   * 混合检索版 repo-map 上下文（BM25 ∪ 语义向量，RRF 融合）。
   * 仅在调用方传入有效 EmbeddingPort 时启用；任意嵌入/召回异常 → 回落纯 BM25（fail-closed），
   * 绝不因语义层失败而崩主流程或丢上下文。
   * @param root workspace 根路径。
   * @param q 查询文本。
   * @param embedding 嵌入端口。
   * @param opts 选项。
   * @returns 上下文文本，或 null（空查询 / 索引失败且 BM25 回退亦失败）。
   */
  public async getHybridRepoMapContext(
    root: string,
    q: string,
    embedding: EmbeddingPort,
    opts: RepoMapContextOptions = {},
  ): Promise<string | null> {
    if (root === '' || q.trim() === '') {
      return null;
    }
    const corpus = this.corpusCache.get(root);
    if (corpus === null) {
      return null;
    }
    try {
      // 旋钮一次性解析并冻结（快照语义），供索引构建与融合共用，避免散落的 env 读取。
      const knobs = new RecallKnobs(opts);
      const idx = await this.semanticCache.get(root, corpus, embedding, knobs);
      const { bm25SymIds, bm25FileIds } = this.retrieveLexical(corpus, q);
      const semanticHits = await idx.search(q, SEMANTIC_CANDIDATES);
      const ranked = this.ranker.rank({
        root,
        corpus,
        knobs,
        bm25SymIds,
        bm25FileIds,
        semanticHits,
      });
      return this.formatContext(ranked, corpus);
    } catch {
      // fail-closed：语义层失败 → 回落纯 BM25 上下文。
      return this.getRepoMapContext(root, q, opts);
    }
  }

  /**
   * 手动失效缓存（某个 workspace 文件结构剧变时调用，可选）。同时清语义索引缓存与图信号缓存。
   * @param root 指定则只失效该工作区；缺省清空全部（不含图信号，图按 workspace 独立缓存）。
   
 * @returns 无返回值。
*/
  public clear(root?: string): void {
    this.corpusCache.clear(root);
    this.semanticCache.clear(root);
    if (root !== undefined) {
      // P5 稀疏引用图按 root 缓存，文件结构剧变须同步失效。
      clearGraphSignal(root);
    }
  }

  /**
   * 分块语义召回项构造（对外暴露供单测；实现委派 `SemanticIndexCache`）。
   * @param corpus 已索引语料。
   * @returns 分块召回项。
   */
  public buildChunkItems(corpus: IndexedCorpus): RecallItem[] {
    return this.semanticCache.buildChunkItems(corpus);
  }

  /**
   * BM25 词法检索：产出符号路 / 文件路命中 id。
   * @param corpus 已索引语料。
   * @param q 查询文本。
   * @returns `sym:<i>` 与 `file:<rel>` 两组命中 id。
   */
  private retrieveLexical(
    corpus: IndexedCorpus,
    q: string,
  ): { bm25SymIds: string[]; bm25FileIds: string[] } {
    const tk = corpus.morph ? tokenizeExpanded(q) : tokenize(q);
    const bm25SymIds = [...corpus.symbolIndex.search(tk, BM25_SYM_CANDIDATES)].map(
      (h) => `sym:${h.id}`,
    );
    const bm25FileIds = [...corpus.fileIndex.search(tk, BM25_FILE_CANDIDATES)]
      .map((h) => corpus.files[h.id]?.rel)
      .filter((rel): rel is string => rel !== undefined)
      .map((rel) => `file:${rel}`);
    return { bm25SymIds, bm25FileIds };
  }

  /**
   * 把融合结果格式化为可注入 system 消息的上下文文本。
   * @param ranked 融合排序结果（入选文件 + 符号）。
   * @param corpus 已索引语料（用于取入选文件的 outline）。
   * @returns 上下文文本。
   */
  private formatContext(ranked: RankedRepoMap, corpus: IndexedCorpus): string {
    const fileSet = new Set(ranked.files);
    const outline = outlineText(corpus.symbols.filter((s) => fileSet.has(s.file)));
    const sigLines = ranked.symbols.map((s) => `L${s.line} ${s.kind} ${s.name} @ ${s.file}`);
    return ['# Repo Map (relevant files)', outline, '# Relevant Symbols', ...sigLines].join('\n');
  }
}
