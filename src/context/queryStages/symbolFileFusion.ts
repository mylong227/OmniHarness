/**
 * 符号-文件融合阶段（C7 拆分，2026-10-02）：图扩散 / 基线 → 文件混合分 → 候选池。
 *
 * 从 `ContextEngine.query` 原样迁出（逻辑逐字等价，仅结构化入参/出参）。
 * 文件混合分口径：max(文件BM25, 0.7×最强符号分, 0.5×层化图分)。
 */
import { CodeGraphIndex, type CodeGraph } from '../codeGraphIndex.js';
import type { SymbolNode } from '../repoMap/repoMap.js';
import type { ScoredId } from './candidateSearch.js';
import { LayeredGraphFusion } from './layeredGraphFusion.js';

/** 融合阶段所需的语料切片（结构化子集）。 */
export interface FusionCorpusView {
  /** 代码拓扑图（HippoRAG 式图检索，跨文件引用边）。 */
  readonly codeGraph: CodeGraph;
  /** 符号全集（与扩散分数按索引一一对应）。 */
  readonly symbols: readonly SymbolNode[];
  /** 文件记录（按 id 索引；此处只需 rel）。 */
  readonly files: readonly { readonly rel: string }[];
  /** 原始文件内容（rel → text），层化图构建用。 */
  readonly fileText: ReadonlyMap<string, string>;
}

/** 融合阶段选项。 */
export interface FusionOptions {
  /** 图扩散（实测在本语料上净负面，默认关，仅供评测开启）。 */
  readonly graph: boolean;
  /** 层化图软融合（第三路，默认关，仅供评测开启）。 */
  readonly layered: boolean;
}

/** 融合阶段产物。 */
export interface FusionResult {
  /** 扩散/基线后的符号分数（符号输出用）。 */
  readonly finalScores: Float64Array;
  /** 第一段候选文件（完整 fileScore 排序，不截断——截断由重排/FILE_K 承担）。 */
  readonly candidateFiles: readonly string[];
}

/**
 * 符号-文件融合阶段：种子分数 → 图扩散（或基线）→ 文件混合分 → 候选池。
 */
export class SymbolFileFusion {
  /**
   * 融合符号与文件分数，产出第一段候选池。
   *
   * @param corpus 语料切片。
   * @param options 融合选项（graph / layered 开关）。
   * @param seed 种子分数（种子融合阶段产物）。
   * @param symIdSet 符号并集（原地补充图/层化图命中的符号）。
   * @param fileHits 文件路 BM25 命中（搜索阶段产物）。
   * @returns 符号分数与候选文件。
   */
  public static fuse(
    corpus: FusionCorpusView,
    options: FusionOptions,
    seed: ReadonlyMap<number, number>,
    symIdSet: Set<number>,
    fileHits: readonly ScoredId[],
  ): FusionResult {
    const finalScores = SymbolFileFusion.spread(corpus, options.graph, seed, symIdSet);
    const bestSymbolScore = SymbolFileFusion.bestSymbolScores(corpus, symIdSet, finalScores);
    const layeredFileScore = options.layered
      ? LayeredGraphFusion.fuse(corpus, seed, symIdSet)
      : new Map<string, number>();
    return {
      finalScores,
      candidateFiles: SymbolFileFusion.fileScores(
        corpus,
        fileHits,
        bestSymbolScore,
        layeredFileScore,
      ),
    };
  }

  /**
   * 图扩散（graph:true）或种子直通基线（graph 关，= 上一轮 58.5% 配置）。
   *
   * @param corpus 语料切片。
   * @param useGraph 是否启用图扩散。
   * @param seed 种子分数。
   * @param symIdSet 符号并集（graph 路把过阈符号并入）。
   * @returns 每个符号的最终分数。
   */
  private static spread(
    corpus: FusionCorpusView,
    useGraph: boolean,
    seed: ReadonlyMap<number, number>,
    symIdSet: Set<number>,
  ): Float64Array {
    let finalScores: Float64Array;
    if (useGraph) {
      finalScores = CodeGraphIndex.propagate(corpus.codeGraph, seed, 4, 0.85);
      let fmax = 0;
      for (let i = 0; i < finalScores.length; i++) fmax = Math.max(fmax, finalScores[i] ?? 0);
      const THRESH = 0.12 * (fmax || 1);
      for (let i = 0; i < finalScores.length; i++) {
        if ((finalScores[i] ?? 0) >= THRESH) symIdSet.add(i);
      }
      return finalScores;
    }
    // 关图：直接以种子分数聚合，作为可对照的 baseline（= 上一轮 58.5% 配置）。
    finalScores = new Float64Array(corpus.symbols.length);
    for (const [id, v] of seed) {
      if (id >= 0 && id < finalScores.length) finalScores[id] = v;
    }
    return finalScores;
  }

  /**
   * 每个文件内最强符号分（用扩散后分值，关联符号被抬升 → 关联文件被捞回）。
   *
   * @param corpus 语料切片。
   * @param symIdSet 符号并集。
   * @param finalScores 符号最终分数。
   * @returns 文件 → 最强符号分。
   */
  private static bestSymbolScores(
    corpus: FusionCorpusView,
    symIdSet: ReadonlySet<number>,
    finalScores: Float64Array,
  ): Map<string, number> {
    const bestSymbolScore = new Map<string, number>();
    for (const id of symIdSet) {
      const s = corpus.symbols[id];
      if (s === undefined) continue;
      const sc = finalScores[id] ?? 0;
      const cur = bestSymbolScore.get(s.file) ?? 0;
      if (sc > cur) bestSymbolScore.set(s.file, sc);
    }
    return bestSymbolScore;
  }

  /**
   * 文件混合分（max 融合）并产出候选池（完整排序，不截断）。
   *
   * @param corpus 语料切片。
   * @param fileHits 文件路 BM25 命中。
   * @param bestSymbolScore 文件 → 最强符号分。
   * @param layeredFileScore 文件 → 层化图分（未启用为空表）。
   * @returns 候选文件（按混合分降序）。
   */
  private static fileScores(
    corpus: FusionCorpusView,
    fileHits: readonly ScoredId[],
    bestSymbolScore: ReadonlyMap<string, number>,
    layeredFileScore: ReadonlyMap<string, number>,
  ): readonly string[] {
    const fileScore = new Map<string, number>();
    for (const h of fileHits) {
      const f = corpus.files[h.id];
      if (f === undefined) continue;
      const sym = bestSymbolScore.get(f.rel) ?? 0;
      const lay = layeredFileScore.get(f.rel) ?? 0;
      fileScore.set(f.rel, Math.max(h.score, 0.7 * sym, 0.5 * lay));
    }
    for (const [file, sym] of bestSymbolScore) {
      if (!fileScore.has(file)) fileScore.set(file, 0.7 * sym);
    }
    for (const [file, lay] of layeredFileScore) {
      if (!fileScore.has(file)) fileScore.set(file, 0.5 * lay);
    }
    // 第一段候选（**完整** fileScore，不按 FILE_K 截断）：候选池已由「BM25 文件路 ∪ 符号路映射回的文件」
    // 构成——实测该池在真实语料上已饱和（继续放大池子上界，召回 0 增益），故**不另起候选源**
    // （新候选源若与查询不敏感即构成常量偏置，见 `rankVetoEvaluator`）。
    return [...fileScore.entries()].sort((a, b) => b[1] - a[1]).map(([rel]) => rel);
  }
}
