/**
 * 层化代码图（T2 ①：把「节点 → 边」的翻译**显式化**）。
 *
 * ## 为什么要重写建边
 *
 * 既有的 {@link buildCodeGraph}（`codeGraph.ts`）是这样建边的：
 *
 * ```ts
 * for (const li of localIds)      // 该文件定义的每个符号
 *   for (const rid of refArr)     // 该文件引用到的每个外部符号（上限 48）
 *     addEdge(li, rid, w);        // 笛卡尔积，全连
 * ```
 *
 * 两个致命缺陷：
 * 1. **笛卡尔积**：50 个符号 × 48 个引用 = 单文件 2400 条边 ⇒ 全库 429k 稠密边。
 * 2. **丢位置**：`collectReferencedSymbols` 把 `tokenize(text)` 结果塞进 `Set`，
 *    行号信息全部丢失 ⇒ 边退化为「文件的任意符号 ↔ 文件的任意引用」，与查询无关。
 *
 * 后果（`evals/rank-veto-retro.mjs` 实测，33 条真实查询）：
 * 图路由的 Top-14 **跨查询平均重合度 0.936**——33 条查询几乎返回同一批枢纽文件。
 * 它不是「退化」，是**常量偏置**。BM25 同口径仅 0.058。
 *
 * ## 层化做了什么
 *
 * 把「边」从「文件提到过这个名字」升级为「**符号 s 在其作用域内引用了符号 t**」，
 * 并让两端各自携带**层坐标**，只有坐标相容时才建边、且按相容度加权：
 *
 * - **作用域层（必需）**：引用必须落在某符号的作用域内才归属给该符号。
 *   判定 = 该行上方**最近的**、缩进 **≤ 引用行缩进**的符号定义。
 *   这一步把边数从 O(|syms| × |refs|) 降到 O(|refs|)，是稀疏化的主因。
 * - **结构层（加权）**：形参个数（arity）、导出性、跨模块性、被引用频次（idf）。
 *   「调用深度 / 参数数 / 跨模块性」是调用方坐标，
 *   「被调频次 / 导出性」是被调方坐标——两侧坐标共同决定边权。
 *
 * ## 不变量
 *
 * - 纯函数、零 IO、零运行时依赖、确定性可复现（同输入 ⇒ 同邻接表）。
 * - 复用 {@link propagate} 做带重启随机游走，不另造扩散器。
 *
 * ## ⚠️ 实测结论：负结果（2026-09-12）
 *
 * 稀疏化目标确实达成：稠密 **583,492** 边 → 层化 **35,032** 边（**16.7×**），
 * 且否决器第一关放行（查询敏感度 **0.038**，与 BM25 簇重合度 0.247）。
 *
 * 但第二关召回 AB（`evals/layered-recall-ab.mjs`，32 条有效查询，fileK=14）实测：
 *
 * | 路由                    | 召回   | Δ        |
 * | ----------------------- | ------ | -------- |
 * | BM25 基线（生产路径）   | 38.0%  | —        |
 * | 层化图（本模块）        | 28.9%  | **−9.1pp** |
 * | 稠密图（负对照）        | 27.5%  | −10.4pp  |
 * | 最优融合（4+10）        | 39.1%  | +1.1pp，但 CI 跨 0 |
 *
 * 最优融合的 +1.1pp 经 bootstrap（2000 次）得 95% CI = **[−4.46, +7.93]pp**，跨 0
 * ⇒ 与噪声不可区分。单查询分布：提升 3 / 持平 18 / 下降 11，净负面。
 *
 * ⇒ **禁止默认启用本模块作召回优化**。保留价值有三：
 *   ① 作为「图路」研究的稀疏化前置（稠密图的问题确实是笛卡尔积）；
 *   ② 作为否决器的**假阴性样本**（通过第一关却实测为负，证明两关不可省）；
 *   ③ 作用域归属与层坐标抽取（`scopeOwners` / `arityOf`）可复用于其它图构建。
 *
 * @maturity L2 — 作用域归属与层坐标加权已实现、单测覆盖、行为可复现；
 *   但**效果已实测为负**（−9.1pp），不得据此声称任何召回收益
 * @maturityEvidence tests/unit/layeredCodeGraph.test.ts
 */

import { tokenize } from '../search/bm25Index.js';
import { NOISE_NAMES, propagate } from './codeGraphIndex.js';
import type { CodeGraph, GraphSource } from './codeGraphIndex.js';
import type { SymbolNode } from './repoMap.js';

/**
 * LayeredCodeGraph — 宿主类：收拢本模块原顶层内部函数（C7 顶层函数收敛），提供统一命名空间。
 */
class LayeredCodeGraph {
  /**
   * 解析层化选项，填充默认值。
   * @param {LayeredGraphOptions | undefined} options - options
   * @returns {ResolvedOptions} - result
   */
  public static resolveOptions(options: LayeredGraphOptions | undefined): ResolvedOptions {
    return {
      maxRefsPerFile: options?.maxRefsPerFile ?? 64,
      crossModuleBoost: options?.crossModuleBoost ?? true,
      exportBoost: options?.exportBoost ?? true,
      maxScopeSpan: options?.maxScopeSpan ?? 120,
    };
  }

  /**
   * 建立「符号名 → 符号 id 列表」索引，供引用名解析使用。
   * @param {readonly SymbolNode[]} symbols - symbols
   * @returns {Map<string, number[]>} - result
   */
  public static indexByName(symbols: readonly SymbolNode[]): Map<string, number[]> {
    const byName = new Map<string, number[]>();
    for (let i = 0; i < symbols.length; i += 1) {
      const nm = symbols[i]?.name;
      if (nm === undefined) continue;
      const arr = byName.get(nm);
      if (arr === undefined) byName.set(nm, [i]);
      else arr.push(i);
    }
    return byName;
  }

  /**
   * 建立「文件 → 该文件内符号 id」索引，组内按行号升序。
   * @param {readonly SymbolNode[]} symbols - symbols
   * @returns {Map<string, number[]>} - result
   */
  public static indexByFile(symbols: readonly SymbolNode[]): Map<string, number[]> {
    const byFile = new Map<string, number[]>();
    for (let i = 0; i < symbols.length; i += 1) {
      const f = symbols[i]?.file;
      if (f === undefined) continue;
      const arr = byFile.get(f);
      if (arr === undefined) byFile.set(f, [i]);
      else arr.push(i);
    }
    for (const arr of byFile.values()) {
      arr.sort((a, b) => (symbols[a]?.line ?? 0) - (symbols[b]?.line ?? 0));
    }
    return byFile;
  }

  /**
   * 统计符号名的文档频率 `df[name]` = 含该名的**文件数**（逆文档频率调制的分母）。 以文件而非符号为计数单位：重名符号在同一文件内只计一次，避免高频工具名被内部重载放大。
   * @param {readonly SymbolNode[]} symbols - symbols
   * @param {ReadonlyMap<string, readonly number[]>} byFile - byFile
   * @returns {Map<string, number>} - result
   */
  public static documentFrequency(
    symbols: readonly SymbolNode[],
    byFile: ReadonlyMap<string, readonly number[]>,
  ): Map<string, number> {
    const df = new Map<string, number>();
    for (const ids of byFile.values()) {
      const local = new Set<string>();
      for (const id of ids) {
        const nm = symbols[id]?.name;
        if (nm !== undefined) local.add(nm);
      }
      for (const nm of local) df.set(nm, (df.get(nm) ?? 0) + 1);
    }
    return df;
  }

  /**
   * 计算一次引用的**层坐标一致性权重**。 组成（与模块头部的层坐标定义一一对应）： - 逆文档频率基线 `0.9 / (1 + log2(df + 1))`：罕见名权重高； - 被调方导出 ×1.25：更可能是有意依赖； - 跨模块引用 ×1.15：信息量高于同模块内的常规引用； - 调用形参 > 3 ×0.9：抑制大函数枢纽化。
   * @param {NodeLayer} target - target
   * @param {NodeLayer} host - host
   * @param {number} df - df
   * @param {ResolvedOptions} opt - opt
   * @returns {number} - result
   */
  public static layerWeight(
    target: NodeLayer,
    host: NodeLayer,
    df: number,
    opt: ResolvedOptions,
  ): number {
    let w = 0.9 / (1 + Math.log2(df + 1));
    if (opt.exportBoost && target.exported) w *= 1.25;
    if (opt.crossModuleBoost && target.module !== host.module) w *= 1.15;
    if (host.arity > 3) w *= 0.9;
    return w;
  }

  /**
   * 写入一条无向边（取重边最大值），自环与非正权重直接丢弃。
   * @param {Map<number, Map<number, number>>} edges - edges
   * @param {number} a - a
   * @param {number} b - b
   * @param {number} w - w
   * @returns {void} - result
   */
  public static pushEdge(
    edges: Map<number, Map<number, number>>,
    a: number,
    b: number,
    w: number,
  ): void {
    if (a === b || !(w > 0)) return;
    let m = edges.get(a);
    if (m === undefined) {
      m = new Map();
      edges.set(a, m);
    }
    const cur = m.get(b) ?? 0;
    if (w > cur) m.set(b, w);
  }

  /**
   * 逐文件扫描引用行：按作用域归属确定宿主，再按层坐标加权写入跨文件边。 同文件内的引用**不建边**（已由 file-union 覆盖），图只负责跨文件关联。
   * @param {GraphSource} corpus - corpus
   * @param {EdgeBuildContext} ctx - ctx
   * @returns {Map<number, Map<number, number>>} - result
   */
  public static collectEdges(
    corpus: GraphSource,
    ctx: EdgeBuildContext,
  ): Map<number, Map<number, number>> {
    const { syms, layers, nameToIds, byFile, df, opt } = ctx;
    const edges = new Map<number, Map<number, number>>();

    for (const [rel, text] of corpus.fileText) {
      const localIdx = byFile.get(rel);
      if (localIdx === undefined || localIdx.length === 0) continue;
      const localSyms = localIdx
        .map((i) => syms[i])
        .filter((s): s is SymbolNode => s !== undefined);
      const lines = text.split('\n');
      const owners = scopeOwners(lines, localSyms, opt.maxScopeSpan);

      let collected = 0;
      for (let li = 0; li < lines.length && collected < opt.maxRefsPerFile; li += 1) {
        const hostPos = owners[li];
        if (hostPos === undefined || hostPos < 0) continue;
        const hostId = localIdx[hostPos];
        if (hostId === undefined) continue;
        const hostLayer = layers[hostId];
        if (hostLayer === undefined) continue;

        for (const tok of new Set(tokenize(lines[li] ?? ''))) {
          if (tok.length < 3 || NOISE_NAMES.has(tok)) continue;
          const ids = nameToIds.get(tok);
          if (ids === undefined) continue;
          for (const tid of ids) {
            if (tid === hostId) continue;
            const tl = layers[tid];
            const ts = syms[tid];
            if (tl === undefined || ts === undefined) continue;
            if (ts.file === rel) continue;

            LayeredCodeGraph.pushEdge(
              edges,
              hostId,
              tid,
              LayeredCodeGraph.layerWeight(tl, hostLayer, df.get(ts.name) ?? 1, opt),
            );
            LayeredCodeGraph.pushEdge(
              edges,
              tid,
              hostId,
              LayeredCodeGraph.layerWeight(tl, hostLayer, df.get(ts.name) ?? 1, opt),
            );
            collected += 1;
            if (collected >= opt.maxRefsPerFile) break;
          }
          if (collected >= opt.maxRefsPerFile) break;
        }
      }
    }
    return edges;
  }

  /**
   * 把稀疏边集展开为 {@link CodeGraph} 的邻接表形式。
   * @param {ReadonlyMap<number, ReadonlyMap<number, number>>} edges - edges
   * @param {number} n - n
   * @returns {CodeGraph} - result
   */
  public static toAdjacency(
    edges: ReadonlyMap<number, ReadonlyMap<number, number>>,
    n: number,
  ): CodeGraph {
    const adj: Array<Array<readonly [number, number]>> = new Array(n);
    for (let i = 0; i < n; i += 1) {
      const m = edges.get(i);
      adj[i] = m === undefined ? [] : [...m].map(([j, w]) => [j, w] as const);
    }
    return { n, adj };
  }
}

/**
 * 符号在边上的**层坐标**（调用方与被调方共用同一组坐标维度）。
 */
export interface NodeLayer {
  /** 形参个数（顶层逗号 + 1；无参数列表记 0）。 */
  readonly arity: number;
  /** 是否对外导出（`export` 关键字）。 */
  readonly exported: boolean;
  /** 所属模块：文件的一级目录；根目录下的文件记 `'.'`。 */
  readonly module: string;
  /** 定义行的缩进空格数，用于作用域归属判定。 */
  readonly indent: number;
}

/**
 * 层化建边的可调选项。
 */
export interface LayeredGraphOptions {
  /** 单个文件最多收录多少条引用边（限流，防超大文件拉爆图）。默认 64。 */
  readonly maxRefsPerFile?: number;
  /** 是否启用跨模块加成（跨模块引用权重更高）。默认 true。 */
  readonly crossModuleBoost?: boolean;
  /** 是否启用导出性加成（导出的被调方权重更高）。默认 true。 */
  readonly exportBoost?: boolean;
  /** 引用行与宿主符号定义行的最大行距；超距视为「非该作用域」而丢弃。默认 120。 */
  readonly maxScopeSpan?: number;
}

/** 解析后的选项（所有字段均已填充默认值）。 */
interface ResolvedOptions {
  readonly maxRefsPerFile: number;
  readonly crossModuleBoost: boolean;
  readonly exportBoost: boolean;
  readonly maxScopeSpan: number;
}

/**
 * 计算单行文本的缩进空格数（制表符按 2 空格折算）。
 *
 * @param line 单行文本（不含换行符）
 * @returns 前导空白折算出的缩进宽度
 */
export function indentOf(line: string): number {
  let n = 0;
  for (const ch of line) {
    if (ch === ' ') n += 1;
    else if (ch === '\t') n += 2;
    else break;
  }
  return n;
}

/**
 * 从紧凑签名估算形参个数。
 *
 * 取第一对圆括号内的内容，只数**顶层**逗号（跳过 `<>[]{}()` 嵌套）。
 * 这是正则级近似，非 AST：默认参数、解构、泛型尖括号里的逗号可能被误计，
 * 但对「区分零参/单参/多参」这一用途足够。
 *
 * @param signature 紧凑签名文本（如 `public query(q: string, limit: number): Hit[]`）
 * @returns 形参个数；无参数列表或空参记 0
 */
export function arityOf(signature: string): number {
  const open = signature.indexOf('(');
  const close = signature.lastIndexOf(')');
  if (open < 0 || close <= open + 1) return 0;
  const inner = signature.slice(open + 1, close).trim();
  if (inner.length === 0) return 0;
  let depth = 0;
  let commas = 0;
  for (const ch of inner) {
    if (ch === '<' || ch === '[' || ch === '{' || ch === '(') depth += 1;
    else if (ch === '>' || ch === ']' || ch === '}' || ch === ')') depth -= 1;
    else if (ch === ',' && depth === 0) commas += 1;
  }
  return commas + 1;
}

/**
 * 取文件所属模块（一级目录；根目录下的文件记 `'.'`）。
 *
 * @param rel 相对仓库根的路径（分隔符统一为 `/`）
 * @returns 模块标识
 */
export function moduleOf(rel: string): string {
  const parts = rel.split('/');
  if (parts.length <= 1) return '.';
  return parts[0] ?? '.';
}

/**
 * 批量计算语料中每个符号的层坐标。
 *
 * @param symbols 符号节点序列（下标即符号 id）
 * @returns 与 `symbols` 等长、下标一一对应的层坐标数组
 */
export function nodeLayers(symbols: readonly SymbolNode[]): NodeLayer[] {
  return symbols.map((s) => ({
    arity: arityOf(s.signature),
    exported: /^\s*export\b/.test(s.signature),
    module: moduleOf(s.file),
    indent: indentOf(s.signature),
  }));
}

/**
 * 为单个文件建立「引用行 → 宿主符号 id」的作用域归属表。
 *
 * 归属规则：引用行 L 归属给**上方最近的**、满足
 * 「定义行 ≤ L 且 缩进 ≤ L 行缩进 且 行距 ≤ maxScopeSpan」的符号。
 * 找不到宿主的行返回 `-1`（该行引用不建边）。
 *
 * 复杂度：O(行数 + 符号数)，两路指针线性扫描。
 *
 * @param lines     文件按行切分后的文本
 * @param localSyms 该文件内的符号，按行号升序
 * @param maxSpan   宿主与引用行的最大行距
 * @returns 长度等于 `lines` 的数组，元素为宿主符号 id 或 `-1`
 */
export function scopeOwners(
  lines: readonly string[],
  localSyms: readonly SymbolNode[],
  maxSpan: number,
): number[] {
  const owners = new Array<number>(lines.length).fill(-1);
  if (localSyms.length === 0) return owners;

  // 预计算每行的缩进，避免在两路扫描里重复解析。
  const indents = lines.map(indentOf);

  // 候选宿主按行号升序；用栈维持「当前可见的作用域链」。
  const stack: Array<{ readonly line: number; readonly indent: number; readonly id: number }> = [];
  let si = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const curIndent = indents[i] ?? 0;
    // 把行号 <= i 的新符号压栈。
    while (si < localSyms.length && (localSyms[si]?.line ?? 0) - 1 <= i) {
      const s = localSyms[si];
      if (s !== undefined) {
        stack.push({ line: s.line - 1, indent: indentOf(s.signature), id: si });
      }
      si += 1;
    }
    // 弹出缩进 > 当前行的（作用域已闭合）与超出跨度的。
    while (stack.length > 0) {
      const top = stack[stack.length - 1];
      if (top === undefined) break;
      if (top.indent > curIndent || i - top.line > maxSpan) stack.pop();
      else break;
    }
    const top = stack[stack.length - 1];
    // 定义行自身不归属给自己（避免自环噪音）。
    owners[i] = top !== undefined && top.line < i ? top.id : -1;
  }
  return owners;
}

/** 建边所需的预计算索引（避免在多重循环里重复传递散参数）。 */
interface EdgeBuildContext {
  /** 符号节点序列（下标即符号 id）。 */
  readonly syms: readonly SymbolNode[];
  /** 与 `syms` 等长的层坐标数组。 */
  readonly layers: readonly NodeLayer[];
  /** 符号名 → 符号 id 列表（引用名解析用）。 */
  readonly nameToIds: ReadonlyMap<string, number[]>;
  /** 文件 → 该文件内符号 id（按行号升序）。 */
  readonly byFile: ReadonlyMap<string, number[]>;
  /** 符号名的文档频率（含该名的文件数）。 */
  readonly df: ReadonlyMap<string, number>;
  /** 已填充默认值的选项。 */
  readonly opt: ResolvedOptions;
}

/**
 * 构建**层化**代码图。
 *
 * 与 {@link buildCodeGraph} 的差别：
 * - 边由「作用域归属」而非「文件笛卡尔积」确定 ⇒ 稀疏且带位置语义；
 * - 边权由层坐标一致性调制（跨模块 / 导出性 / idf）⇒ 罕见且跨模块的引用更强。
 *
 * @param corpus  最小语料视图（符号 + 文件文本）
 * @param options 可选调参
 * @returns 有向带权邻接表形式的图
 */
export function buildLayeredCodeGraph(
  corpus: GraphSource,
  options?: LayeredGraphOptions,
): CodeGraph {
  const opt = LayeredCodeGraph.resolveOptions(options);
  const syms = corpus.symbols;
  const n = syms.length;
  const byFile = LayeredCodeGraph.indexByFile(syms);
  const ctx: EdgeBuildContext = {
    syms,
    layers: nodeLayers(syms),
    nameToIds: LayeredCodeGraph.indexByName(syms),
    byFile,
    df: LayeredCodeGraph.documentFrequency(syms, byFile),
    opt,
  };
  return LayeredCodeGraph.toAdjacency(LayeredCodeGraph.collectEdges(corpus, ctx), n);
}

/**
 * 在层化图上做带重启随机游走，聚合成**文件级**排序。
 *
 * @param symbols 符号节点序列（用于把符号分归到文件）
 * @param graph   {@link buildLayeredCodeGraph} 产出的图
 * @param seed    种子分数：符号 id → 原始分（如 BM25 命中分）
 * @param limit   返回的文件数上限
 * @param iters   扩散轮数，默认 4
 * @param damping 阻尼系数，默认 0.85
 * @returns 按分数降序的文件相对路径列表（已去重）
 */
export function layeredFileRoute(
  symbols: readonly SymbolNode[],
  graph: CodeGraph,
  seed: ReadonlyMap<number, number>,
  limit: number,
  iters = 4,
  damping = 0.85,
): string[] {
  const scores = propagate(graph, seed, iters, damping);
  const byFile = new Map<string, number>();
  for (let i = 0; i < scores.length; i += 1) {
    const f = symbols[i]?.file;
    if (f === undefined) continue;
    const v = scores[i] ?? 0;
    if (v <= 0) continue;
    const cur = byFile.get(f) ?? 0;
    if (v > cur) byFile.set(f, v);
  }
  return [...byFile.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([f]) => f);
}

/**
 * 统计图的边数（有向），用于稀疏度对照与回归断言。
 *
 * @param graph 待统计的图
 * @returns 有向边总数
 */
export function edgeCountOf(graph: CodeGraph): number {
  let n = 0;
  for (const es of graph.adj) n += es.length;
  return n;
}
