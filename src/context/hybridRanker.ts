/**
 * 混合检索融合排序器（HybridRanker）——把多路召回融合成「相关文件 + 相关符号」。
 *
 * 设计要点：
 *  - 纯算法、无状态、无 IO：输入各路的**排名列表**（BM25 符号/文件 + 语义命中），输出结构化排序结果。
 *    不含嵌入、不含缓存、不拼字符串——便于单测与跨场景复用（可移植 / 可复用）。
 *  - 融合走语义召回模块的 `rrfMerge`（Reciprocal Rank Fusion）：对分数尺度不敏感、无需归一化。
 *  - 四路可组合：
 *      1) BM25 文件路（恒有权重 1）
 *      2) 语义文件路（权重 knobs.semWeight）
 *      3) 符号→文件映射路（把语义命中的符号映射回所属文件，默认开，实测 +5pp）
 *      4) 分块→文件映射路（chunk 命中映射回文件，默认关）
 *      5) P5 稀疏引用图第四路（默认关；多跳难查询净负，已证伪）
 *  - BM25 保护位（knobs.bm25Floor）：融合后强制钉住 BM25 头部文件，封顶「个别查询回退」风险。
 *  - 图信号异常一律 fail-closed 跳过第四路，绝不崩主流程。
 */

import type { IndexedCorpus } from './contextEngine.js';
import type { SymbolNode } from './repoMap.js';
import { SemanticIndex, type RecallHit } from './semanticIndex.js';
import { CodeReferenceGraph } from './codeReferenceGraph.js';
import type { RecallKnobs } from './recallKnobs.js';

/** 融合排序结果：入选文件（rel 路径，按融合分降序）与符号（已截断到预算）。 */
export interface RankedRepoMap {
  /** 入选文件 rel 路径（已截断到 fileK）。 */
  readonly files: readonly string[];
  /**
   * 融合后的**完整**文件排名（未按 fileK 截断）。
   * 供第二段精排当候选池：重排只能在**入池候选**里换位，池子截断得越早、重排可动的余地越小
   * （实测教训：候选池只取 BM25 文件路 top-20 时，重排后命中率 66.7%；放成完整 fileScore 池后 75.8%）。
   */
  readonly allFiles: readonly string[];
  /** 入选符号（已截断到 symK）。 */
  readonly symbols: readonly SymbolNode[];
}

/** 融合输入（各路命中已就绪）。 */
export interface HybridRankInput {
  /** workspace 根路径（供图信号按 root 取缓存）。 */
  readonly root: string;
  /** 已索引语料（用于符号/文件 id 反查）。 */
  readonly corpus: IndexedCorpus;
  /** 已解析旋钮。 */
  readonly knobs: RecallKnobs;
  /** BM25 符号路命中 id（形如 `sym:<i>`）。 */
  readonly bm25SymIds: readonly string[];
  /** BM25 文件路命中 id（形如 `file:<rel>`）。 */
  readonly bm25FileIds: readonly string[];
  /** 语义路命中（含 `sym:`/`file:`/`chunk:` 三类 id）。 */
  readonly semanticHits: readonly RecallHit[];
}

export class HybridRanker {
  /**
   * 融合排序。
   * @param input 语料 + 旋钮 + 三路命中。
   * @returns 入选文件与符号（均已截断到预算）。
   */
  public rank(input: HybridRankInput): RankedRepoMap {
    const { root, corpus, knobs, bm25SymIds, bm25FileIds, semanticHits } = input;
    const { symSemIds, fileSemIds, chunkSemIds } = this.splitSemantic(semanticHits);

    // 符号→文件融合：语义命中的符号映射回所属文件，让符号级精度直接抬升文件级召回。
    const symSemFileIds = knobs.mergeSymbols ? this.mapSymbolsToFiles(corpus, symSemIds) : [];
    // BM25 符号路 → 文件：**纯 BM25 路径本来就有这一路**（`ContextEngine.query` 的 `fileScore`
    // 取 `max(文件BM25分, 0.7 × 该文件最强符号分)`），而混合路径此前**漏了这一路**——
    // 它的文件候选池只有「BM25 文件路 top-20 ∪ 语义命中」，于是符号级命中若没被语义路复述，
    // 其所属文件就进不了池。实测（33 条对抗锚点，生产入口）：补上此路 78.8% → **81.8%**。
    // 同一开关控制（`mergeSymbols`，默认开）——本就是同一件事「符号命中回抬其文件」。
    const symBm25FileIds = knobs.mergeSymbols ? this.mapSymbolsToFiles(corpus, bm25SymIds) : [];
    // 分块语义召回：chunk 命中映射回所属文件，作为额外融合路（与符号→文件同机制）。
    const chunkSemFileIds = knobs.chunkRecall ? this.mapSymbolsToFiles(corpus, chunkSemIds) : [];

    const toHits = (ids: readonly string[]): { id: string }[] => ids.map((id) => ({ id }));
    // 符号融合：BM25 符号路 ∪ 语义符号路，等权/semWeight 加权。
    const mergedSym = SemanticIndex.rrfMerge([toHits(bm25SymIds), toHits(symSemIds)], knobs.rrfK, [
      1,
      knobs.semWeight,
    ]);

    // 文件融合：BM25 文件路恒为第一路（权重 1），其余路按开关与权重追加。
    const fileLists: Array<readonly { readonly id: string }[]> = [
      toHits(bm25FileIds),
      toHits(fileSemIds),
    ];
    const fileWeights: number[] = [1, knobs.semWeight];
    if (knobs.mergeSymbols) {
      // BM25 符号路映射（权重 1，与 BM25 文件路同属词法侧）。
      fileLists.push(toHits(symBm25FileIds));
      fileWeights.push(1);
      fileLists.push(toHits(symSemFileIds));
      fileWeights.push(knobs.semWeight);
    }
    if (knobs.chunkRecall) {
      fileLists.push(toHits(chunkSemFileIds));
      fileWeights.push(knobs.semWeight);
    }
    // P5 第四路：fail-closed——图构建/扩散/邻域提取任一异常 → 跳过第四路。
    if (knobs.graphSignal) {
      const graphIds = this.graphFileIds(root, corpus, [...bm25SymIds, ...symSemIds]);
      if (graphIds.length > 0) {
        fileLists.push(toHits(graphIds));
        fileWeights.push(knobs.graphWeight);
      }
    }
    const mergedFile = SemanticIndex.rrfMerge(fileLists, knobs.rrfK, fileWeights);

    const allFiles = mergedFile.map((id) => id.slice('file:'.length));
    let rankedFiles = allFiles.slice(0, knobs.fileK);
    if (knobs.bm25Floor > 0) {
      rankedFiles = this.applyBm25Floor(rankedFiles, bm25FileIds, knobs.bm25Floor, knobs.fileK);
    }
    const rankedSymbols = mergedSym
      .slice(0, knobs.symK)
      .map((id) => corpus.symbols[Number(id.slice('sym:'.length))])
      .filter((s): s is SymbolNode => s !== undefined);

    return { files: rankedFiles, allFiles, symbols: rankedSymbols };
  }

  /**
   * 按 id 前缀把语义命中拆成符号 / 文件 / 分块三组。
   * @param hits 语义命中列表。
   * @returns 三组 id。
   */
  private splitSemantic(hits: readonly RecallHit[]): {
    symSemIds: string[];
    fileSemIds: string[];
    chunkSemIds: string[];
  } {
    const symSemIds: string[] = [];
    const fileSemIds: string[] = [];
    const chunkSemIds: string[] = [];
    for (const h of hits) {
      if (h.id.startsWith('sym:')) {
        symSemIds.push(h.id);
      } else if (h.id.startsWith('file:')) {
        fileSemIds.push(h.id);
      } else if (h.id.startsWith('chunk:')) {
        chunkSemIds.push(h.id);
      }
    }
    return { symSemIds, fileSemIds, chunkSemIds };
  }

  /**
   * 把 `sym:<i>` / `chunk:<i>` 命中 id 映射回其所属文件（`file:<rel>`）。
   * 非法下标（越界 / NaN）安全跳过。
   * @param corpus 已索引语料。
   * @param ids 命中 id 列表。
   * @returns 对应文件 id 列表（可能含重复，RRF 内自然累加）。
   */
  private mapSymbolsToFiles(corpus: IndexedCorpus, ids: readonly string[]): string[] {
    const out: string[] = [];
    for (const id of ids) {
      const sym = corpus.symbols[Number(id.slice(id.indexOf(':') + 1))];
      if (sym !== undefined) {
        out.push(`file:${sym.file}`);
      }
    }
    return out;
  }

  /**
   * BM25 保护位：把 BM25 头部 N 个文件钉在结果最前（保持其自身次序），其余按融合次序补齐，末尾截断到 fileK。
   * @param ranked 融合后的文件 rel 列表。
   * @param bm25FileIds BM25 文件路命中 id（形如 `file:<rel>`）。
   * @param floor 保护个数 N。
   * @param fileK 文件预算（保护位不得突破）。
   * @returns 新列表。
   */
  private applyBm25Floor(
    ranked: readonly string[],
    bm25FileIds: readonly string[],
    floor: number,
    fileK: number,
  ): string[] {
    const protectedRels = bm25FileIds.slice(0, floor).map((id) => id.slice('file:'.length));
    const protectedSet = new Set(protectedRels);
    const rest = ranked.filter((rel) => !protectedSet.has(rel));
    return [...protectedRels, ...rest].slice(0, fileK);
  }

  /**
   * P5 稀疏引用图第四路：以命中符号为 seed 扩散 1 跳，收集邻居文件（按中心性降序）。
   * @param root workspace 根路径。
   * @param corpus 已索引语料。
   * @param seedIds seed 命中 id（`sym:<i>`）。
   * @returns 邻居文件 id 列表（`file:<rel>`）；图异常或空则返回空数组（fail-closed）。
   */
  private graphFileIds(root: string, corpus: IndexedCorpus, seedIds: readonly string[]): string[] {
    try {
      const seedSymIdx: number[] = [];
      for (const id of seedIds) {
        const n = Number(id.slice(id.indexOf(':') + 1));
        if (Number.isFinite(n)) {
          seedSymIdx.push(n);
        }
      }
      if (seedSymIdx.length === 0) {
        return [];
      }
      const sig = CodeReferenceGraph.getGraphSignal(root, corpus);
      return CodeReferenceGraph.graphNeighborFileRoute(corpus, seedSymIdx, sig);
    } catch {
      return [];
    }
  }
}
