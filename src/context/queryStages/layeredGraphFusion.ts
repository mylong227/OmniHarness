/**
 * 层化图融合阶段（C7 拆分，2026-10-02）：E4 深化的第三路软融合。
 *
 * 从 `ContextEngine.query` 原样迁出（逻辑逐字等价）。
 * 根因（evals/layered-recall-ab.mjs 实测）：层化图此前作「替换」BM25 用，丢掉整文件
 * 词法命中信号 → −9.1pp。改为把图扩散分并入 fileScore 的 max，图只负责「捞回靠关联符号
 * 但无词法命中」的文件，文件 BM25 始终为地板项（绝不被静默丢弃）。
 */
import { CodeGraphIndex, type CodeGraph } from '../codeGraphIndex.js';
import { LayeredCodeGraph } from '../layeredCodeGraph.js';
import type { SymbolNode } from '../repoMap.js';
import type { ScoredId } from './candidateSearch.js';

/** 层化图阶段所需的语料切片（结构化子集）。 */
export interface LayeredCorpusView {
  /** 符号全集（与扩散分数按索引一一对应）。 */
  readonly symbols: readonly SymbolNode[];
  /** 原始文件内容（rel → text），层化图构建用。 */
  readonly fileText: ReadonlyMap<string, string>;
}

/** 层化图缓存（同一语料零重算；键即调用方传入的语料实例）。 */
const LAYERED_CACHE = new WeakMap<object, CodeGraph>();

/**
 * 层化图融合：扩散 → 归一化 → 映射回文件级分数。
 */
export class LayeredGraphFusion {
  /**
   * 语料的层化代码图（按语料实例缓存；自 ContextEngine 迁入）。
   *
   * @param corpus 语料切片。
   * @returns 层化代码图。
   */
  public static layeredGraph(corpus: LayeredCorpusView): CodeGraph {
    const cached = LAYERED_CACHE.get(corpus);
    if (cached !== undefined) return cached;
    const g = LayeredCodeGraph.buildLayeredCodeGraph({
      symbols: corpus.symbols,
      fileText: corpus.fileText,
    });
    LAYERED_CACHE.set(corpus, g);
    return g;
  }

  /**
   * 层化图扩散并映射回文件分数；命中的符号 id 一并并入符号集。
   *
   * @param corpus 语料切片。
   * @param seed 种子分数（种子融合阶段产物）。
   * @param symIdSet 符号并集（原地补充层化图命中的符号）。
   * @returns 文件 → 层化图分（归一化后）。
   */
  public static fuse(
    corpus: LayeredCorpusView,
    seed: ReadonlyMap<number, number>,
    symIdSet: Set<number>,
  ): Map<string, number> {
    const lg = LayeredGraphFusion.layeredGraph(corpus);
    const lscores = CodeGraphIndex.propagate(lg, seed, 4, 0.85);
    let lmax = 0;
    for (let i = 0; i < lscores.length; i += 1) lmax = Math.max(lmax, lscores[i] ?? 0);
    const linv = lmax > 0 ? 1 / lmax : 0;
    const layeredFileScore = new Map<string, number>();
    for (let i = 0; i < lscores.length; i += 1) {
      const v = (lscores[i] ?? 0) * linv;
      if (v <= 0) continue;
      const s = corpus.symbols[i];
      if (s === undefined) continue;
      symIdSet.add(i);
      const cur = layeredFileScore.get(s.file) ?? 0;
      if (v > cur) layeredFileScore.set(s.file, v);
    }
    return layeredFileScore;
  }
}

/** 供类型复用（ScoredId 的重新导出别名，保持阶段间入参同源）。 */
export type { ScoredId };
