/**
 * 零依赖代码拓扑图（HippoRAG 式图检索的「代码原生」落地）。
 *
 * 思路：把 repo-map 的符号视为图节点，用代码里**真实存在**的关系建边——
 *   - 跨文件引用：`fileA` 的某符号名出现在 `fileB` 的方法体里 → 两符号间有关联边。
 *   - 边的权重用符号名的「逆文档频率」调制：越罕见的名字（如 execPolicy）权重越高，
 *     越常见的名字（如 get/run）权重越低，避免噪声把图糊成全连通。
 *
 * 这一层不依赖任何 LLM / embedding：边直接来自 AST 抽取的符号 + 文本引用扫描，
 * 因此可确定性复现。它解决的是纯词法 BM25 的天花板——query "sandbox policy
 * evaluated" 与含 `execPolicy` 的文件无字面共现，但通过「同文件/同模块引用」的
 * 图扩散，相关文件会被真实捞回。
 *
 * 查询时用 PageRank 式带重启的随机游走得扩散种子分数（BM25/共振命中的符号），
 * 让关联符号的分值沿边传播，再按文件聚合重排。
 */

import { Bm25Index } from '../search/bm25Index.js';
import type { SymbolNode } from './repoMap.js';
import { ArrayAt } from '../util/arrayAt.js';

/**
 * CodeGraphIndex 相关纯函数工具（C7 收口：原顶层内部函数迁入）。
 */
export class CodeGraphIndex {
  /**
   * 符号名 → 符号 id 列表（用于引用扫描）。
   * @param syms readonly SymbolNode[]
   * @returns Map<string, number[]>
   */
  public static buildNameIndex(syms: readonly SymbolNode[]): Map<string, number[]> {
    const m = new Map<string, number[]>();
    for (let i = 0; i < syms.length; i++) {
      const nm = ArrayAt.at(syms, i).name;
      let arr = m.get(nm);
      if (arr === undefined) {
        arr = [];
        m.set(nm, arr);
      }
      arr.push(i);
    }
    return m;
  }
  /**
   * 文件 → 该文件包含的符号 id 列表。
   * @param syms readonly SymbolNode[]
   * @returns Map<string, number[]>
   */
  public static buildFileIndex(syms: readonly SymbolNode[]): Map<string, number[]> {
    const m = new Map<string, number[]>();
    for (let i = 0; i < syms.length; i++) {
      const f = ArrayAt.at(syms, i).file;
      let arr = m.get(f);
      if (arr === undefined) {
        arr = [];
        m.set(f, arr);
      }
      arr.push(i);
    }
    return m;
  }
  /**
   * 文档频率 df[name] = 包含该符号名的文件数（用于逆文档频率加权）。
   * @param syms readonly SymbolNode[]
   * @param byFile ReadonlyMap<string, readonly number[]>
   * @returns Map<string, number>
   */
  public static buildDocFreq(
    syms: readonly SymbolNode[],
    byFile: ReadonlyMap<string, readonly number[]>,
  ): Map<string, number> {
    const df = new Map<string, number>();
    for (const ids of byFile.values()) {
      const localNames = new Set<string>();
      for (const id of ids) localNames.add(ArrayAt.at(syms, id).name);
      for (const nm of localNames) df.set(nm, (df.get(nm) ?? 0) + 1);
    }
    return df;
  }
  /**
   * 扫描单个文件文本，收集它真正引用到的其他符号 id（噪声名与超长文件受限）。
   * @param text string
   * @param nameToIds ReadonlyMap<string, readonly number[]>
   * @param limit number
   * @returns number[]
   */
  public static collectReferencedSymbols(
    text: string,
    nameToIds: ReadonlyMap<string, readonly number[]>,
    limit = 48,
  ): number[] {
    const refIds = new Set<number>();
    for (const t of new Set(Bm25Index.tokenize(text))) {
      if (t.length < 3 || NOISE_NAMES.has(t)) continue;
      const ids = nameToIds.get(t);
      if (ids === undefined) continue;
      for (const id of ids) refIds.add(id);
    }
    return [...refIds].slice(0, limit); // 超大文件限流，避免拉爆图
  }

  /**
   * 从已索引语料构建代码拓扑图。
   * 复杂度：O(符号数 + 文件数 × 文件 token 数)，对中等仓库（数千符号）是毫秒级。
   */
  public static buildCodeGraph(corpus: GraphSource): CodeGraph {
    const syms = corpus.symbols;
    const n = syms.length;

    const nameToIds = CodeGraphIndex.buildNameIndex(syms);
    const byFile = CodeGraphIndex.buildFileIndex(syms);
    const df = CodeGraphIndex.buildDocFreq(syms, byFile);

    // 边集合：source -> (target -> 最大权重)，去重且只保留最强边。
    const edges = new Map<number, Map<number, number>>();
    const addEdge = (a: number, b: number, w: number): void => {
      if (a === b) return;
      let m = edges.get(a);
      if (m === undefined) {
        m = new Map();
        edges.set(a, m);
      }
      const cur = m.get(b) ?? 0;
      if (w > cur) m.set(b, w);
    };

    // 跨文件引用边：扫描每个文件文本，找出它真正引用到的其他符号名。
    for (const [rel, text] of corpus.fileText) {
      const localIds = byFile.get(rel);
      if (localIds === undefined || localIds.length === 0) continue;
      const refArr = CodeGraphIndex.collectReferencedSymbols(text, nameToIds);
      for (const li of localIds) {
        for (const rid of refArr) {
          if (rid === li) continue;
          // 同文件已由 file-union 覆盖，图只负责跨文件关联
          if (ArrayAt.at(syms, li).file === ArrayAt.at(syms, rid).file) continue;
          const d = df.get(ArrayAt.at(syms, rid).name) ?? 1;
          // 逆文档频率调制：罕见名权重高，常见名权重低。
          const w = 0.9 / (1 + Math.log2(d + 1));
          addEdge(li, rid, w);
          addEdge(rid, li, w);
        }
      }
    }

    // 转成只读邻接表。
    const adj: Array<Array<readonly [number, number]>> = new Array(n);
    for (let i = 0; i < n; i++) {
      const m = edges.get(i);
      adj[i] = m === undefined ? [] : [...m.entries()].map(([j, w]) => [j, w] as const);
    }
    return { n, adj };
  }

  /**
   * PageRank 式带重启随机游走扩散。
   *
   * @param g        代码拓扑图
   * @param seed     种子分数（BM25/共振命中的符号 id → 原始分）
   * @param iters    迭代轮数
   * @param damping  阻尼系数（每轮沿边扩散的比例，其余回流到种子）
   * @returns        每个符号节点的扩散后分值
   *
   * 不变量：种子节点的分数通过阻尼系数被「记住」，扩散不会把信号淹死；
   * 关联节点（被边连接的符号）会随迭代获得提升，从而把召回从纯词法天花板拉出来。
   */
  public static propagate(
    g: CodeGraph,
    seed: ReadonlyMap<number, number>,
    iters = 4,
    damping = 0.85,
  ): Float64Array {
    const n = g.n;
    const s = new Float64Array(n);
    let maxSeed = 0;
    for (const [id, v] of seed) {
      if (id >= 0 && id < n) {
        s[id] = v;
        if (v > maxSeed) maxSeed = v;
      }
    }
    if (maxSeed > 0) {
      for (let i = 0; i < n; i++) s[i] = ArrayAt.at(s, i) / maxSeed; // 归一化，避免数值漂移
    }

    for (let it = 0; it < iters; it++) {
      const nx = new Float64Array(n);
      for (let i = 0; i < n; i++) {
        const es = ArrayAt.at(g.adj, i);
        if (es.length === 0) continue;
        let wsum = 0;
        for (const [, w] of es) wsum += w;
        const contrib = (ArrayAt.at(s, i) * damping) / wsum;
        for (const [j, w] of es) nx[j] = (nx[j] ?? 0) + contrib * w;
      }
      // 带重启：未沿边扩散的部分回流到种子（保持原始查询信号不丢失）。
      const restart = 1 - damping;
      for (const [id, v] of seed) {
        if (id >= 0 && id < n) nx[id] = (nx[id] ?? 0) + v * restart;
      }
      s.set(nx);
    }
    return s;
  }
}

/** 构建图所需的最小语料视图（避免与 IndexedCorpus 形成循环类型依赖）。 */
export interface GraphSource {
  readonly symbols: readonly SymbolNode[];
  readonly fileText: ReadonlyMap<string, string>;
}

/** 有向带权邻接表：adj[i] = [[邻居j, 权重], ...]。 */
export interface CodeGraph {
  readonly n: number;
  readonly adj: ReadonlyArray<ReadonlyArray<readonly [number, number]>>;
}

/**
 * 代码停用词 + 短名过滤：这些名字当引用边太噪，直接丢弃。
 *
 * 导出给 {@link buildLayeredCodeGraph} 复用（层化图与稠密图必须共用同一份噪声集，
 * 否则两侧实验不可比）。
 */
export const NOISE_NAMES = new Set([
  'get',
  'set',
  'run',
  'id',
  'ids',
  'data',
  'type',
  'name',
  'value',
  'key',
  'item',
  'result',
  'error',
  'state',
  'config',
  'ctx',
  'self',
  'this',
  'fn',
  'func',
  'do',
  'new',
  'to',
  'from',
  'is',
  'has',
  'use',
  'map',
  'list',
  'add',
  'init',
  'build',
  'create',
  'update',
  'getConfig',
  'setConfig',
]);
