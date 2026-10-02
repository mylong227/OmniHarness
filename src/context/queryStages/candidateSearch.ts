/**
 * 候选搜索阶段（C7 拆分，2026-10-02）：BM25 双路检索 + PRF 查询扩展。
 *
 * 从 `ContextEngine.query` 原样迁出（逻辑逐字等价，仅结构化入参/出参）：
 * 拆分动机是审计 C7——`query()` 224 行 / 11 职责不可单测隔离；按阶段拆类后
 * 每段可独立测试与替换，编排器保持薄。
 *
 * 调用方传**结构化切片**（`SearchCorpusView`）而不是 `IndexedCorpus` 本体：
 * 阶段文件不反向依赖 contextEngine，避免新增依赖环（架构门禁对新增类型环阻断）。
 */
import { Bm25Index } from '../../search/bm25Index.js';
import { ContentStopWords } from '../contentStopWords.js';

/** 语料级文档频率缓存（同一语料重复查询零重算；键即调用方传入的语料实例）。 */
const DF_CACHE = new WeakMap<object, Map<string, number>>();

/** 单条命中（BM25 检索产物的形状）。 */
export interface ScoredId {
  readonly id: number;
  readonly score: number;
}

/** 搜索阶段所需的语料切片（结构化子集）。 */
export interface SearchCorpusView {
  /** 索引时是否启用词形归并；查询侧据此同步选择分词器（两侧须一致）。 */
  readonly morph: boolean;
  /** 文件记录（按 id 索引；此处只需 rel）。 */
  readonly files: readonly { readonly rel: string }[];
  /** 符号级 BM25 索引。 */
  readonly symbolIndex: Bm25Index;
  /** 文件级 BM25 索引。 */
  readonly fileIndex: Bm25Index;
  /** 原始文件内容（rel → text），PRF 反馈集读取用。 */
  readonly fileText: ReadonlyMap<string, string>;
}

/** 搜索阶段选项（透传 `query()` 的对应字段）。 */
export interface CandidateSearchOptions {
  /** 伪相关反馈（PRF / RM3 风格查询扩展）。 */
  readonly prf?: boolean;
  /** BM25 `k1` 的打分期覆盖（调参扫描用）；缺省用索引构造期取值。 */
  readonly bm25K1?: number;
  /** BM25 `b` 的打分期覆盖（调参扫描用）；缺省用索引构造期取值。 */
  readonly bm25B?: number;
}

/** 搜索阶段产物。 */
export interface CandidateSearchResult {
  /** 符号路 BM25 命中（Top-60）。 */
  readonly bm25SymHits: readonly ScoredId[];
  /** 文件路 BM25 命中（Top-20）。 */
  readonly fileHits: readonly ScoredId[];
}

/**
 * 候选搜索阶段：BM25 符号路 ∪ 文件路，可选 PRF 扩展重跑。
 */
export class CandidateSearch {
  /**
   * 执行搜索（PRF 开启时用扩展查询**重跑替换**，不是并集）。
   *
   * PRF 要点（经 evals/recall-precision.mjs 实测校准）：
   *  - 取首轮 Top-R 文件（R=20）作反馈集，TF·IDF 选 Top-E 扩展词（E=6）；
   *  - **重排（替换）而非并集**：朴素并集会把泛化词命中的文件顶进头部（实测 hitRate 39%→9% 崩塌）。
   *
   * @param corpus 语料切片。
   * @param q 原始查询。
   * @param options 搜索选项。
   * @returns 搜索产物（最终候选命中，PRF 替换已生效）。
   */
  public static search(
    corpus: SearchCorpusView,
    q: string,
    options: CandidateSearchOptions = {},
  ): CandidateSearchResult {
    const qk = corpus.morph ? Bm25Index.tokenizeExpanded(q) : Bm25Index.tokenize(q);
    const bm25Args = {
      ...(options.bm25K1 !== undefined ? { k1: options.bm25K1 } : {}),
      ...(options.bm25B !== undefined ? { b: options.bm25B } : {}),
    };
    let bm25SymHits: ScoredId[] = [...corpus.symbolIndex.search(qk, 60, bm25Args)];
    let fileHits: ScoredId[] = [...corpus.fileIndex.search(qk, 20, bm25Args)];
    if (options.prf) {
      const expanded = CandidateSearch.prfExpandedQuery(corpus, q, fileHits);
      if (expanded !== undefined) {
        const eqk = Bm25Index.tokenizeExpanded(expanded);
        bm25SymHits = [...corpus.symbolIndex.search(eqk, 60, bm25Args)];
        fileHits = [...corpus.fileIndex.search(eqk, 20, bm25Args)];
      }
    }
    return { bm25SymHits, fileHits };
  }

  /**
   * 构造 PRF 扩展查询（原 Top-20 文件 TF·IDF 反馈，拼在原查询后）；无扩展词时为 undefined。
   *
   * @param corpus 语料切片。
   * @param q 原始查询。
   * @param fileHits 首轮文件命中。
   * @returns 扩展查询串；无扩展词为 undefined。
   */
  private static prfExpandedQuery(
    corpus: SearchCorpusView,
    q: string,
    fileHits: readonly ScoredId[],
  ): string | undefined {
    const df = CandidateSearch.docFreqOf(corpus);
    const N = corpus.files.length;
    const topFiles = fileHits
      .slice(0, 20)
      .map((h) => corpus.files[h.id]?.rel)
      .filter((r): r is string => r !== undefined);
    const fb = new Map<string, number>();
    for (const rel of topFiles) {
      const text = corpus.fileText.get(rel);
      if (text === undefined) continue;
      const tf = new Map<string, number>();
      for (const t of Bm25Index.tokenizeExpanded(text)) {
        if (!ContentStopWords.isContent(t)) continue;
        tf.set(t, (tf.get(t) ?? 0) + 1);
      }
      const len = Math.max(
        1,
        [...tf.values()].reduce((a, b) => a + b, 0),
      );
      for (const [t, c] of tf) {
        const d = df.get(t) ?? 0;
        const idf = Math.log((N - d + 0.5) / (d + 0.5) + 1);
        fb.set(t, (fb.get(t) ?? 0) + (c / len) * idf);
      }
    }
    const qTok = new Set(Bm25Index.tokenizeExpanded(q));
    const extra = [...fb.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map((e) => e[0])
      .filter((t) => !qTok.has(t));
    if (extra.length === 0) {
      return undefined;
    }
    return `${q} ${extra.join(' ')}`;
  }

  /**
   * 语料级文档频率（df）视图，按语料实例缓存（同一语料重复查询零重算；自 ContextEngine 迁入）。
   *
   * @param corpus 语料切片（WeakMap 以该实例为键）。
   * @returns 词元 → 出现该词元的文件数。
   */
  private static docFreqOf(corpus: SearchCorpusView): Map<string, number> {
    const cached = DF_CACHE.get(corpus);
    if (cached !== undefined) return cached;
    const df = new Map<string, number>();
    for (const text of corpus.fileText.values()) {
      const seen = new Set(Bm25Index.tokenizeExpanded(text));
      for (const t of seen) df.set(t, (df.get(t) ?? 0) + 1);
    }
    DF_CACHE.set(corpus, df);
    return df;
  }
}
