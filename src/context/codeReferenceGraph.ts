/**
 * P5 图/结构信号第四路（同行实证有效：Aider 符号引用图 PageRank / Greptile 调用图多跳 /
 * Cody 代码图 SCIP）。这是把「代码库当互联图而非文档袋」的离线零重嵌税落地。
 *
 * 为什么是一张**新图**而不是复用既有 codeGraph：
 *   - 既有 buildCodeGraph 在 omniharness 语料上建出 429k 稠密边，文件召回实测 −6.1pp（负）。
 *     **根因已由 evals/rank-veto-retro.mjs 实测更正**：并非「PageRank 收敛至近均匀」——
 *     实测稳态 KL 0.522、有效支撑率 0.593、度 Gini 0.482，分布远非均匀。
 *     真机理是**排序对查询不敏感**：33 条真实查询的 Top-14 跨查询平均重合度 **0.936**（BM25 仅 0.058），
 *     枢纽文件在 33/33 查询中全部出现 ⇒ 这是一记**常量偏置**，只会挤占 Top-K 预算。
 *   - 另一个不能复用的硬伤：buildCodeGraph 的名字索引用原始 camelCase 符号名，而
 *     tokenize 全小写——camelCase 符号（execPolicy / registerTool）在引用扫描里永远
 *     匹配不上，跨文件引用边系统性缺失。本模块自建**小写归一**的引用匹配修正此点。
 *   - 本模块改走**稀疏引用图**：仅保留「稀有共享标识符」（df ≤ MAX_DF_FOR_EDGE）的边——
 *     只有「两文件都引用了同一个罕见符号（如 ApprovalStore / execPolicy）」才连边。
 *     这种边是真正高信号的结构关联，类比化学里「共享稀有子结构」的 Tanimoto 相似。
 *   - 中心性用标准 PageRank（复用 codeGraph.propagate，均匀重启种子），
 *     文件中心性 = 其成员符号中心性之和（归一化）。
 *
 * 查询期第四路：以查询命中符号（BM25 ∪ 语义）为 seed，沿稀疏图扩散 HOP 跳，
 * 收集邻居符号 → 文件，按文件中心性降序排成 `file:`-id 列表，作为 RRF 第四路并入
 * mergedFile（仅含邻居文件，seed 自身文件已在 BM25/语义路中，避免重复加权）。
 *
 * 全程 fail-closed：图构建/扩散/邻域提取任一异常 → 调用方跳过第四路，不崩主流程。
 * 默认关（opt-in）：`graphSignal: true` / env OMNI_GRAPH_SIGNAL=1。
 *
 * @maturity L1 — 幂迭代存在；44 万边实测零增益。注：早期注释把根因写成「谱隙→0 收敛到均匀」，
 *   方向写反且已被实测证伪（谱隙 0.31、稳态远非均匀）；真机理是查询不敏感型常量偏置
 * @maturityEvidence tests/unit/codeReferenceGraph.test.ts
 */
import { CodeGraphIndex } from './codeGraphIndex.js';
import type { CodeGraph } from './codeGraphIndex.js';
import { Bm25Index } from '../search/bm25Index.js';
import type { IndexedCorpus } from './contextEngine.js';
import { ArrayAt } from '../util/arrayAt.js';

/**
 * CodeReferenceGraph — 宿主类：收拢本模块原顶层内部函数（C7 顶层函数收敛），提供统一命名空间。
 */
export class CodeReferenceGraph {
  /**
   * 符号名（小写归一）→ 符号 id 列表。
   * @param {IndexedCorpus['symbols']} symbols - symbols
   * @returns {Map<string, number[]>} - result
   */
  public static buildLowerNameIndex(symbols: IndexedCorpus['symbols']): Map<string, number[]> {
    const m = new Map<string, number[]>();
    for (let i = 0; i < symbols.length; i++) {
      const nm = ArrayAt.at(symbols, i).name.toLowerCase();
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
   * @param {IndexedCorpus['symbols']} symbols - symbols
   * @returns {Map<string, number[]>} - result
   */
  public static buildFileIndex(symbols: IndexedCorpus['symbols']): Map<string, number[]> {
    const m = new Map<string, number[]>();
    for (let i = 0; i < symbols.length; i++) {
      const f = ArrayAt.at(symbols, i).file;
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
   * 文档频率 df[name] = 定义该符号名的文件数（用于稀有性过滤与逆文档频率加权）。
   * @param {IndexedCorpus['symbols']} symbols - symbols
   * @param {ReadonlyMap<string, readonly number[]>} byFile - byFile
   * @returns {Map<string, number>} - result
   */
  public static buildDocFreq(
    symbols: IndexedCorpus['symbols'],
    byFile: ReadonlyMap<string, readonly number[]>,
  ): Map<string, number> {
    const df = new Map<string, number>();
    for (const ids of byFile.values()) {
      const localNames = new Set<string>();
      for (const id of ids) localNames.add(ArrayAt.at(symbols, id).name.toLowerCase());
      for (const nm of localNames) df.set(nm, (df.get(nm) ?? 0) + 1);
    }
    return df;
  }

  /**
   * 进程级图信号缓存的**有界写入**：容量已满且是新 root 时，按插入序淘汰最旧一条。
   *
   * 为什么必须做（2026-09-19 堆爆审计）：这是按 root 键的进程级 Map，长驻进程（server /
   * 多工作区）会不断累积「图 + 文件中心性」；无上限即同一类无界增长。
   *
   * @param root 即将写入的根路径。
   * @returns 无返回值。
   */
  public static evictIfFull(root: string): void {
    if (cache.has(root) || cache.size < MAX_CACHED_ROOTS) {
      return;
    }
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) {
      cache.delete(oldest);
    }
  }

  /**
   * 构建（或复用按 root 缓存的）稀疏引用图 + 文件中心性。
   * 任意失败向上抛，由调用方 fail-closed 跳过第四路（不污染主检索）。
   */
  public static getGraphSignal(root: string, corpus: IndexedCorpus): GraphSignal {
    const existing = cache.get(root);
    if (existing !== undefined) {
      return existing;
    }
    const symbols = corpus.symbols;
    const nameToIds = CodeReferenceGraph.buildLowerNameIndex(symbols);
    const byFile = CodeReferenceGraph.buildFileIndex(symbols);
    const df = CodeReferenceGraph.buildDocFreq(symbols, byFile);

    // 稀疏引用边：source -> (target -> 权重)，只保留 df ≤ MAX_DF_FOR_EDGE 的罕见共享名。
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
    // 跨文件引用边：扫描每个文件文本（tokenize 全小写，与名字索引同归一化），
    // 找出它真正引用到的、定义在其他文件里的罕见符号。
    for (const [rel, text] of corpus.fileText) {
      const localIds = byFile.get(rel);
      if (localIds === undefined || localIds.length === 0) continue;
      const refIds = new Set<number>();
      for (const t of new Set(Bm25Index.tokenize(text))) {
        const ids = nameToIds.get(t);
        if (ids === undefined) continue;
        for (const id of ids) refIds.add(id);
      }
      for (const li of localIds) {
        for (const rid of refIds) {
          if (rid === li) continue;
          // 同文件已由 file-union 覆盖，图只负责跨文件关联。
          if (ArrayAt.at(symbols, li).file === ArrayAt.at(symbols, rid).file) continue;
          const d = df.get(ArrayAt.at(symbols, rid).name.toLowerCase()) ?? 1;
          if (d > MAX_DF_FOR_EDGE) continue; // 稀疏化：常见名不建边。
          // 逆文档频率调制：罕见名权重高，常见名权重低。
          const w = 0.9 / (1 + Math.log2(d + 1));
          addEdge(li, rid, w);
          addEdge(rid, li, w);
        }
      }
    }
    const adj: Array<Array<readonly [number, number]>> = new Array(symbols.length);
    for (let i = 0; i < symbols.length; i++) {
      const m = edges.get(i);
      adj[i] = m === undefined ? [] : [...m.entries()].map(([j, w]) => [j, w] as const);
    }
    let edgeCount = 0;
    for (const es of adj) edgeCount += es.length;
    const sparse: CodeGraph = { n: symbols.length, adj };
    // 标准 PageRank：均匀重启种子 → 所有节点初始分相等，扩散收敛到稳态。
    const uniform = new Map<number, number>();
    const inv = 1 / Math.max(symbols.length, 1);
    for (let i = 0; i < symbols.length; i++) uniform.set(i, inv);
    const scores = CodeGraphIndex.propagate(sparse, uniform, GRAPH_ITERS, DAMPING);
    // 文件中心性 = 其成员符号中心性之和；归一化到 [0,1]。
    const fileCen = new Map<string, number>();
    for (let i = 0; i < symbols.length; i++) {
      const f = symbols[i]?.file;
      if (f === undefined) continue;
      fileCen.set(f, (fileCen.get(f) ?? 0) + (scores[i] ?? 0));
    }
    let max = 0;
    for (const v of fileCen.values()) {
      if (v > max) max = v;
    }
    if (max > 0) {
      for (const [k, v] of fileCen) fileCen.set(k, v / max);
    }
    const sig: GraphSignal = { graph: sparse, edgeCount, fileCentrality: fileCen };
    CodeReferenceGraph.evictIfFull(root);
    cache.set(root, sig);
    return sig;
  }

  /** 失效按 root 缓存的图信号（文件结构剧变时调用）。 */
  public static clearGraphSignal(root?: string): void {
    if (root === undefined) {
      cache.clear();
    } else {
      cache.delete(root);
    }
  }

  /**
   * 查询邻域第四路：以查询命中符号（seed）为源，沿稀疏引用图扩散 HOP 跳，
   * 收集邻居符号 → 文件，按文件中心性降序排成 `file:`-id 列表。
   * 仅含邻居文件（排除 seed 自身符号所属文件，后者已在 BM25/语义路中）。
   *
   * @param corpus     已索引语料（取 symbols[i].file 映射回文件路径）
   * @param seedSymIdx 查询命中的符号下标（BM25 ∪ 语义命中并集）
   * @param sig        稀疏图 + 文件中心性
   * @returns          按文件中心性降序的 `file:<rel>` id 列表（可能为空）
   */
  public static graphNeighborFileRoute(
    corpus: IndexedCorpus,
    seedSymIdx: ReadonlyArray<number>,
    sig: GraphSignal,
  ): string[] {
    const seedSet = new Set(seedSymIdx);
    const visited = new Set(seedSymIdx);
    let frontier = [...seedSymIdx];
    for (let h = 0; h < HOP; h++) {
      const next: number[] = [];
      for (const s of frontier) {
        const es = sig.graph.adj[s];
        if (es === undefined) continue;
        for (const [j] of es) {
          if (!visited.has(j)) {
            visited.add(j);
            next.push(j);
          }
        }
      }
      frontier = next;
      if (frontier.length === 0) break;
    }
    const fileScore = new Map<string, number>();
    for (const j of visited) {
      if (seedSet.has(j)) continue; // 仅邻居文件
      const f = corpus.symbols[j]?.file;
      if (f === undefined) continue;
      const c = sig.fileCentrality.get(f) ?? 0;
      const cur = fileScore.get(f);
      if (cur === undefined || c > cur) fileScore.set(f, c);
    }
    return [...fileScore.entries()].sort((a, b) => b[1] - a[1]).map(([f]) => `file:${f}`);
  }
}

/**
 * 仅保留「稀有共享标识符」边：df ≤ 该值的符号名才参与连边。
 * df 越大说明该名字越常见（如 config/get），连出来的边越像噪声。
 * 取 4 → 只有出现在 ≤4 个文件里的符号名才建边，图足够稀疏且高信号。
 */
const MAX_DF_FOR_EDGE = 4;

/** PageRank 迭代轮数（稀疏图收敛快，24 轮足够稳定）。 */
const GRAPH_ITERS = 24;

/** PageRank 阻尼系数（沿用 codeGraph.propagate 的经典值）。 */
const DAMPING = 0.85;

/** 查询邻域扩散跳数：1 跳 = 直接引用邻居（Aider 经验，「先邻居后远亲」）。 */
const HOP = 1;

/** 图信号产物：稀疏图 + 归一化文件中心性。 */
export interface GraphSignal {
  /** 稀疏化后的邻接表（节点数 = 符号数）。 */
  readonly graph: CodeGraph;
  /** 边总数（用于诚实报告图密度）。 */
  readonly edgeCount: number;
  /** 文件相对路径 → 归一化 PageRank 中心性 [0,1]。 */
  readonly fileCentrality: ReadonlyMap<string, number>;
}

/**
 * 按 root 缓存图信号（进程级，文件结构剧变时 clearGraphSignal 失效）。
 *
 * **有界**（2026-09-19 堆爆审计）：进程级 Map 必须有上限——长驻进程（server / 多工作区）里
 * 每个 root 都会留一份「图 + 文件中心性」，无上限就是同一类无界增长。上限 {@link MAX_CACHED_ROOTS}
 * 按**插入序**淘汰最旧一条（Map 保序），并用 `clearGraphSignal` 提供显式失效。
 */
const cache = new Map<string, GraphSignal>();

/** 进程级图信号缓存的最大 root 数（超出按插入序淘汰最旧）。 */
export const MAX_CACHED_ROOTS = 8;
