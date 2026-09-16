// 蜘蛛网（Spider Web）评测共享构件：文件级带权网 + 个性化 PageRank。
//
// 供 `evals/spider-reach-probe.mjs`（上界探测）与 `evals/spider-pool-ab.mjs`（扩张池 AB）复用，
// 避免评测脚本间复制建网逻辑。**评测专用**：生产实现见 `src/context/spiderWebGraph.ts`。
//
// 与既有 `src/context/codeReferenceGraph.ts`（已实测净负）的差别（三条，缺一不可）：
//   ① 既有是 **1 跳硬邻域 + 全局中心性排序** ⇒ 排序与查询无关，跨查询 Top-14 重合度 0.936（常量偏置）；
//      本模块是 **无限跳几何衰减 + 个性化重启分布**（重启 = 本查询的 BM25 种子）⇒ 分数由「离本查询
//      种子多近」决定，天然查询相关。这正是 HippoRAG 用 PPR 做多跳检索的机理。
//   ② 既有把图分当**替换/并列一路**并入融合，会把词法命中挤出预算（层化图替换 BM25 实测 −9.1pp）；
//      本模块只做**候选池扩张**（只新增、不重排、不删除 BM25 命中），词法序始终是地板。
//   ③ 既有图的符号名索引用小写归一后仍受 camelCase 定义名限制；本模块以文件文本 token 反查
//      「定义该名字的文件」，两侧同为小写 token。

/**
 * 文件级带权无向网。
 * @typedef {object} SpiderGraph
 * @property {string[]} rels 节点下标 → 文件相对路径
 * @property {Map<string, number>} nodeOf 文件相对路径 → 节点下标
 * @property {number} N 节点数
 * @property {Map<number, Map<number, number>>} adj 邻接表（对称，权重取最大）
 * @property {number} edges 无向边数
 * @property {number} refEdges 稀有共享标识符边写入次数（含重边尝试）
 * @property {number} dirEdges 同目录边写入次数
 * @property {number} isolated 孤立节点数
 * @property {number} avgDeg 平均度（无向，含重数去重后）
 */

/**
 * 建文件级蜘蛛网。
 * @param {object} corpus 已索引语料（含 files / symbols / fileText）
 * @param {(t: string) => string[]} tokenize 小写分词器（与语料索引同源）
 * @param {object} [opts] 建网选项
 * @param {number} [opts.maxDf] 稀有共享标识符的 df 上界（超出不连边）
 * @param {number} [opts.dirWeight] 同目录弱边权重
 * @param {number} [opts.maxDirSize] 超过该大小的目录不再加兄弟边（纯噪声）
 * @returns {SpiderGraph} 网
 */
export function buildSpiderGraph(corpus, tokenize, opts = {}) {
  const maxDf = opts.maxDf ?? 4;
  const dirWeight = opts.dirWeight ?? 0.15;
  const maxDirSize = opts.maxDirSize ?? 40;

  const rels = corpus.files.map((f) => f.rel);
  const nodeOf = new Map(rels.map((rel, i) => [rel, i]));
  const N = rels.length;

  const nameToFiles = new Map();
  for (const s of corpus.symbols) {
    const n = s.name.toLowerCase();
    let set = nameToFiles.get(n);
    if (set === undefined) {
      set = new Set();
      nameToFiles.set(n, set);
    }
    set.add(s.file);
  }

  const adj = new Map();
  const addEdge = (i, j, w) => {
    if (i === j) return;
    let m = adj.get(i);
    if (m === undefined) {
      m = new Map();
      adj.set(i, m);
    }
    if (w > (m.get(j) ?? 0)) m.set(j, w);
    let m2 = adj.get(j);
    if (m2 === undefined) {
      m2 = new Map();
      adj.set(j, m2);
    }
    if (w > (m2.get(i) ?? 0)) m2.set(i, w);
  };

  // ① 稀有共享标识符边：本文件 token 中出现「定义在他处的罕见符号名」⇒ 连边。
  let refEdges = 0;
  for (const [rel, text] of corpus.fileText) {
    const i = nodeOf.get(rel);
    if (i === undefined) continue;
    for (const t of new Set(tokenize(text))) {
      const defs = nameToFiles.get(t);
      if (defs === undefined) continue;
      const d = defs.size;
      if (d === 0 || d > maxDf) continue;
      const w = 1 / (1 + Math.log2(d + 1));
      for (const other of defs) {
        if (other === rel) continue;
        const j = nodeOf.get(other);
        if (j === undefined) continue;
        addEdge(i, j, w);
        refEdges++;
      }
    }
  }

  // ② 同目录弱边
  let dirEdges = 0;
  const byDir = new Map();
  for (const rel of rels) {
    const d = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '.';
    let arr = byDir.get(d);
    if (arr === undefined) {
      arr = [];
      byDir.set(d, arr);
    }
    arr.push(rel);
  }
  for (const arr of byDir.values()) {
    if (arr.length < 2 || arr.length > maxDirSize) continue;
    for (let a = 0; a < arr.length; a++) {
      for (let b = a + 1; b < arr.length; b++) {
        const i = nodeOf.get(arr[a]);
        const j = nodeOf.get(arr[b]);
        if (i === undefined || j === undefined) continue;
        addEdge(i, j, dirWeight);
        dirEdges++;
      }
    }
  }

  let edges = 0;
  let isolated = 0;
  for (let i = 0; i < N; i++) {
    const m = adj.get(i);
    const c = m === undefined ? 0 : m.size;
    edges += c;
    if (c === 0) isolated++;
  }
  edges = Math.floor(edges / 2);

  return {
    rels,
    nodeOf,
    N,
    adj,
    edges,
    refEdges,
    dirEdges,
    isolated,
    avgDeg: N === 0 ? 0 : +((2 * edges) / N).toFixed(1),
  };
}

/**
 * 个性化 PageRank：`p = α·s + (1−α)·Wᵀp`，W 行按出边权重归一。
 * 悬挂节点（无出边）把能量均分回全网，避免质量泄漏。
 * @param {SpiderGraph} g 网
 * @param {Float64Array} seedVec 重启分布（未归一化，内部归一）
 * @param {object} [opts] 选项
 * @param {number} [opts.alpha] 重启概率（越大越黏在种子上）
 * @param {number} [opts.iters] 幂迭代轮数
 * @returns {Float64Array} 稳态分布（长度 N）
 */
export function personalizedPageRank(g, seedVec, opts = {}) {
  const alpha = opts.alpha ?? 0.15;
  const iters = opts.iters ?? 30;
  const { N, adj } = g;
  let total = 0;
  for (let i = 0; i < N; i++) total += seedVec[i];
  if (total <= 0) return new Float64Array(N);
  const s = Float64Array.from(seedVec, (v) => v / total);
  const p = Float64Array.from(s);
  const next = new Float64Array(N);
  for (let it = 0; it < iters; it++) {
    next.fill(0);
    for (let i = 0; i < N; i++) {
      const pi = p[i];
      if (pi <= 0) continue;
      const m = adj.get(i);
      if (m === undefined || m.size === 0) {
        const share = (pi * (1 - alpha)) / N;
        for (let k = 0; k < N; k++) next[k] += share;
        continue;
      }
      let wsum = 0;
      for (const w of m.values()) wsum += w;
      const factor = (pi * (1 - alpha)) / wsum;
      for (const [j, w] of m) next[j] += factor * w;
    }
    for (let i = 0; i < N; i++) p[i] = alpha * s[i] + next[i];
  }
  return p;
}

/**
 * 硬 k-hop 邻域（节点下标集合）。
 * @param {SpiderGraph} g 网
 * @param {Iterable<number>} seedIdx 种子节点下标
 * @param {number} hops 跳数
 * @returns {Set<number>} 含种子的邻域集合
 */
export function hopNeighborhood(g, seedIdx, hops) {
  const visited = new Set(seedIdx);
  let frontier = [...seedIdx];
  for (let h = 0; h < hops; h++) {
    const next = [];
    for (const i of frontier) {
      const m = g.adj.get(i);
      if (m === undefined) continue;
      for (const j of m.keys()) {
        if (!visited.has(j)) {
          visited.add(j);
          next.push(j);
        }
      }
    }
    frontier = next;
    if (frontier.length === 0) break;
  }
  return visited;
}

/**
 * 由查询构造 PPR 重启分布：BM25 文件路原始分归一化。
 * @param {object} corpus 已索引语料
 * @param {string[]} qk 查询 token
 * @param {SpiderGraph} g 网
 * @param {number} [topN] 取 BM25 文件路前 N 个作为种子
 * @returns {{seedVec: Float64Array, seedIdx: number[]}} 重启分布与种子下标
 */
export function bm25Seed(corpus, qk, g, topN = 20) {
  const seedVec = new Float64Array(g.N);
  const hits = [...corpus.fileIndex.search(qk, topN)];
  let max = 0;
  for (const h of hits) max = Math.max(max, h.score);
  for (const h of hits) {
    const rel = corpus.files[h.id]?.rel;
    const i = rel === undefined ? undefined : g.nodeOf.get(rel);
    if (i === undefined) continue;
    seedVec[i] = max > 0 ? h.score / max : 0;
  }
  const seedIdx = [];
  for (let i = 0; i < g.N; i++) if (seedVec[i] > 0) seedIdx.push(i);
  return { seedVec, seedIdx };
}

/**
 * PPR 稳态降序的文件名列表。
 * @param {SpiderGraph} g 网
 * @param {Float64Array} ppr 稳态分布
 * @returns {string[]} 按 PPR 分降序的文件相对路径
 */
export function pprOrder(g, ppr) {
  const idx = [];
  for (let i = 0; i < g.N; i++) if (ppr[i] > 0) idx.push(i);
  idx.sort((a, b) => ppr[b] - ppr[a]);
  return idx.map((i) => g.rels[i]);
}
