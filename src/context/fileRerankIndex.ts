/**
 * 重排索引（FileRerankIndex）——两阶段检索第 2 段所需的**语料级词法视图**（惰性、按语料缓存）。
 *
 * 职责单一：把重排要用的词法事实一次性算出来并缓存，供 {@link FileReranker} **只读**消费：
 *  - 每个文件的**声明符号名**词集（用与检索侧同一套分词器，避免两侧变体集不相交）；
 *  - 词项 IDF（直接取 `Bm25Index.idf`，与第一段打分公式同源，杜绝两套口径）；
 *  - 查询侧**内容词**抽取（形态归并 + 去停用词 + 去短词）。
 *
 * 设计约束：
 *  - **不做候选生成**。候选集合沿用第一段（BM25 文件路 ∪ 符号路映射回的文件）——
 *    历史教训：另起一路候选源（图/层化）与查询不敏感即构成**常量偏置**，会挤占 Top-K 预算。
 *    这里只**重排**已入池的文件，故天然没有该风险（见 `rankVetoEvaluator` 的判据）。
 *  - 缓存挂在**语料实例**上（`WeakMap`），语料被回收即随之释放；同一语料多查询零重复计算。
 *  - 纯内存、零 IO、确定性、零第三方依赖。
 *
 * @maturity L1 — 精排用的语料级词法视图（其判据与真实语料实测见 {@link ./fileReranker.ts} 模块头）
 * @maturityEvidence tests/unit/fileRerankIndex.test.ts
 */

import { tokenize, tokenizeExpanded } from '../search/bm25Index.js';
import type { SymbolNode } from './repoMap.js';
import type { IndexedCorpus } from './contextEngine.js';
import { ContentStopWords } from './contentStopWords.js';

/**
 * 单个语料的惰性视图：文件 → 声明符号，以及文件 → 符号名词集（按需填充）。
 */
interface CorpusRerankView {
  /** 文件 rel → 该文件声明的符号（索引期一次，O(符号数)）。 */
  readonly byFile: ReadonlyMap<string, readonly SymbolNode[]>;
  /** 文件 rel → 符号名词集（首次访问该文件时计算并缓存）。 */
  readonly nameTerms: Map<string, ReadonlySet<string>>;
}

/**
 * 词项权重下界：查询里出现、但**整个语料都不含**的词（IDF 无定义）给一个极小正权重，
 * 使其只稀释分母、不主导排序。取 0.05 的理由：语料内最稀有词的 IDF 约 6.1
 * （N=467、df=1 时 `ln(1 + 466.5/1.5) ≈ 5.74`），0.05 比它低两个数量级，不改变相对次序。
 */
const RARE_TERM_WEIGHT_FLOOR = 0.05;

/**
 * 语料级重排词法视图（惰性构建 + 按语料缓存）。
 */
export class FileRerankIndex {
  /** 语料 → 视图。键用语料实例，故语料回收后缓存自动释放。 */
  private readonly views = new WeakMap<IndexedCorpus, CorpusRerankView>();

  /**
   * 取（或构建）某语料的视图。
   * @param corpus 已索引语料
   * @returns 该语料的惰性视图
   */
  private viewOf(corpus: IndexedCorpus): CorpusRerankView {
    const cached = this.views.get(corpus);
    if (cached !== undefined) {
      return cached;
    }
    const byFile = new Map<string, SymbolNode[]>();
    for (const s of corpus.symbols) {
      const arr = byFile.get(s.file);
      if (arr === undefined) {
        byFile.set(s.file, [s]);
      } else {
        arr.push(s);
      }
    }
    const view: CorpusRerankView = { byFile, nameTerms: new Map<string, ReadonlySet<string>>() };
    this.views.set(corpus, view);
    return view;
  }

  /**
   * 取某文件**声明符号名**的词集（camelCase 拆分 + 词形归并；与索引侧同一分词器）。
   * 首次访问该文件时计算并缓存，后续同语料同文件为零成本。
   * @param corpus 已索引语料
   * @param rel 文件相对路径
   * @returns 该文件符号名的词集；文件无声明符号时为空集
   */
  public nameTerms(corpus: IndexedCorpus, rel: string): ReadonlySet<string> {
    const view = this.viewOf(corpus);
    const cached = view.nameTerms.get(rel);
    if (cached !== undefined) {
      return cached;
    }
    const set = new Set<string>();
    for (const s of view.byFile.get(rel) ?? []) {
      for (const t of this.tokenizeLike(corpus, s.name)) {
        set.add(t);
      }
    }
    view.nameTerms.set(rel, set);
    return set;
  }

  /**
   * 抽取查询的**内容词**（去重、保序）：形态归并分词 → 去停用词 → 去短词。
   * 与第一段 `query` 使用同一分词器（`corpus.morph` 决定），保证两侧词形一致。
   * @param corpus 已索引语料（提供 morph 口径）
   * @param query 查询原文
   * @returns 内容词列表（按首次出现次序）
   */
  public contentTerms(corpus: IndexedCorpus, query: string): readonly string[] {
    const out = new Set<string>();
    for (const t of this.tokenizeLike(corpus, query)) {
      if (ContentStopWords.isContent(t)) {
        out.add(t);
      }
    }
    return [...out];
  }

  /**
   * 词项 IDF（取值与第一段 BM25 完全同源）。
   * @param corpus 已索引语料
   * @param term 词项
   * @returns IDF；语料未收录该词时返回 0
   */
  public idf(corpus: IndexedCorpus, term: string): number {
    return corpus.fileIndex.idf(term);
  }

  /**
   * 词项在重排打分中的**权重**：IDF 为正则取之，否则取 {@link RARE_TERM_WEIGHT_FLOOR}。
   * @param corpus 已索引语料
   * @param term 词项
   * @returns 严格为正的权重
   */
  public weight(corpus: IndexedCorpus, term: string): number {
    const v = this.idf(corpus, term);
    return v > 0 ? v : RARE_TERM_WEIGHT_FLOOR;
  }

  /**
   * 按语料形态口径选择分词器（与 `indexCorpus` / `query` 的取值规则一致）。
   * @param corpus 已索引语料（`morph=false` 时退化为基础分词）
   * @param text 待分词文本
   * @returns 词项列表
   */
  private tokenizeLike(corpus: IndexedCorpus, text: string): readonly string[] {
    return corpus.morph ? tokenizeExpanded(text) : tokenize(text);
  }
}
