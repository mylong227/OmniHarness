#!/usr/bin/env node
// 蜘蛛网可达性探测（Spider Reach Probe）——**先验证空间，再写生产代码**。
//
// 回答的问题：把候选可达集从「BM25 词法池」扩张为「词法种子 ∪ 文件级图上的个性化 PageRank 可达区」
// 之后，oracle 天花板能否**突破 81.8%**（`evals/headroom-analysis.mjs` 实测的旧理论值）。
//
// 为什么是 PPR 而不是既有 `graphSignal`（已实测净负）：
//   - 既有方案 = 1 跳硬邻域 + **用全局中心性排序** ⇒ 排序与查询无关，Top-14 跨查询重合度 0.936
//     （常量偏置，只会挤占预算）。根因是「排序函数不含查询」。
//   - PPR = 无限跳几何衰减 + **个性化**（重启分布 = 本查询的 BM25 种子）⇒ 分数由「离本查询种子多近」
//     决定，天然查询相关。这正是 HippoRAG 用 PPR 做多跳检索的机理。
//   - 本脚本只测量：**不落任何生产代码**，先看空间够不够。
//
// 多类边（网的「黏丝」）：
//   ① 稀有共享标识符边（df ≤ MAX_DF）：A 引用了定义在 B 的罕见符号 ⇒ A—B。高信号结构关联。
//   ② 同目录弱边：兄弟文件常同主题（模块内聚）。
//
// 诚实纪律：GT 由锚点字符串反查语料（与 recall-precision 同源）；锚点不存在直接失败；不报无 CI 的点估计。
//
// 用法（免网络、免模型）：
//   node evals/spider-reach-probe.mjs
// 输出：evals/spider-reach-probe.report.json + 控制台摘要。

import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { writeFileSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const DIST = join(ROOT, 'dist', 'src');
const importDist = (...segments) => import(pathToFileURL(join(DIST, ...segments)).href);

const { indexCorpus, query } = await importDist('context', 'contextEngine.js');
const { tokenize } = await importDist('search', 'bm25Index.js');

const SRC = join(ROOT, 'src');
const DEEP = 600;
const RANK_CAP = 200;

/** 稀有共享标识符的 df 上界：只有出现在 ≤该数个文件里的名字才配连边。 */
const MAX_DF_FOR_EDGE = 4;
/** 同目录弱边权重（相对稀有引用边的量级）。 */
const DIR_EDGE_WEIGHT = 0.15;
/** PPR 重启概率 α：越大能量越黏在种子上（越小走得越远）。 */
const ALPHA = 0.15;
/** PPR 幂迭代轮数。 */
const ITERS = 30;
/** 多跳邻域的 hop 数（用于「硬邻域」对照）。 */
const HOPS = [1, 2, 3];

const corpus = indexCorpus(SRC, { morph: true, light: true });
console.log(`语料：${corpus.files.length} 文件 / ${corpus.symbols.length} 符号`);

function groundTruth(anchor) {
  const needle = anchor.toLowerCase();
  const set = new Set();
  for (const [rel, text] of corpus.fileText) {
    if (text.toLowerCase().includes(needle)) set.add(rel);
  }
  return set;
}

// 33 条查询（与 evals/recall-precision.mjs / headroom-analysis.mjs 同源）。
const QUERIES = [
  { q: 'where is tool registration handled', anchor: 'registerTool' },
  { q: 'how does sandbox denial escalate to approval', anchor: 'EscalationPort' },
  { q: 'what does ContextAssembler project events into', anchor: 'class ContextAssembler' },
  { q: 'how are images attached to model messages', anchor: 'imagesOf' },
  { q: 'where is reasoning_effort sent to the openai model', anchor: 'reasoning_effort' },
  { q: 'how does BM25 tokenize CJK text', anchor: 'export function tokenize' },
  { q: 'how is the resonant memory probe mapped from text', anchor: 'resonateByText' },
  { q: 'where is the sandbox policy evaluated', anchor: 'execPolicy' },
  { q: 'how are tool results spilled out of context', anchor: 'spill_read' },
  {
    q: 'which component remembers decisions the operator already blessed',
    anchor: 'ApprovalStore',
  },
  { q: 'how is a signed claim from an agent packaged', anchor: 'AgentAssertionEnvelope' },
  { q: 'which key-value store replicates records across nodes', anchor: 'OobleckStore' },
  { q: 'tuning knobs for the graph that links distant memories', anchor: 'ResonantFieldOptions' },
  { q: 'settings for the planner that gradually cools down', anchor: 'HeatAnnealerOptions' },
  {
    q: 'options controlling what gets pulled out of conversations',
    anchor: 'MemoryExtractorOptions',
  },
  { q: 'knobs for the parity based error correction layer', anchor: 'QECOptions' },
  { q: 'what signals that a parity check has failed', anchor: 'Syndrome' },
  { q: 'where is the remaining spend captured at a point in time', anchor: 'BudgetSnapshot' },
  { q: 'how is a chain of thought persisted to disk', anchor: 'StoredTrace' },
  { q: 'what normalizes text before it is compared', anchor: 'Canonicalizer' },
  { q: 'how long is a prior yes remembered before asking again', anchor: 'CachedApprovalOptions' },
  { q: 'settings for the belief updater that follows curvature', anchor: 'NaturalGradientOptions' },
  {
    q: 'tunables for the sampler tracking many hypotheses at once',
    anchor: 'ParticleFilterOptions',
  },
  { q: 'how is the local vector model configured', anchor: 'TransformersEmbeddingOptions' },
  { q: 'where are ed25519 signing credentials created', anchor: 'KeyPairSync' },
  { q: 'how are orphaned tool call identifiers tracked', anchor: 'ToolCallRef' },
  { q: 'how is the chat completion provider configured', anchor: 'OpenAiCompatibleModel' },
  { q: 'where do language server error reports come from', anchor: 'Diagnostics' },
  { q: 'how many characters of a conversation are retained', anchor: 'TranscriptChars' },
  { q: 'what does a delegated child task return', anchor: 'SubagentResult' },
  { q: 'what represents one entry in a multi stage plan', anchor: 'PlanStep' },
  { q: 'where are capabilities discovered and registered', anchor: 'SkillRegistry' },
  { q: 'which component gates dangerous tool calls at runtime', anchor: 'SupervisorKernel' },
];

for (const { q, anchor } of QUERIES) {
  if (groundTruth(anchor).size === 0) {
    throw new Error(`锚点在语料中不存在（GT=0）：query="${q}" anchor="${anchor}"`);
  }
}

// —— 建网（文件级带权无向图）——
const fileRels = corpus.files.map((f) => f.rel);
const nodeOf = new Map(fileRels.map((rel, i) => [rel, i]));
const N = fileRels.length;

// name(lower) → 定义它的文件集合
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

/** 邻接表：节点 i → Map(节点 j → 权重)。对称写入。 */
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

// ① 稀有共享标识符边：本文件文本里出现「定义在他处的罕见符号名」⇒ 连边。
let refEdges = 0;
for (const [rel, text] of corpus.fileText) {
  const i = nodeOf.get(rel);
  if (i === undefined) continue;
  const toks = new Set(tokenize(text));
  for (const t of toks) {
    const defs = nameToFiles.get(t);
    if (defs === undefined) continue;
    const d = defs.size;
    if (d === 0 || d > MAX_DF_FOR_EDGE) continue;
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
for (const rel of fileRels) {
  const d = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '.';
  let arr = byDir.get(d);
  if (arr === undefined) {
    arr = [];
    byDir.set(d, arr);
  }
  arr.push(rel);
}
for (const arr of byDir.values()) {
  if (arr.length < 2 || arr.length > 40) continue; // 超大目录（如 src/）不加兄弟边，纯噪声
  for (let a = 0; a < arr.length; a++) {
    for (let b = a + 1; b < arr.length; b++) {
      const i = nodeOf.get(arr[a]);
      const j = nodeOf.get(arr[b]);
      if (i === undefined || j === undefined) continue;
      addEdge(i, j, DIR_EDGE_WEIGHT);
      dirEdges++;
    }
  }
}

let edgeCount = 0;
let isolated = 0;
for (let i = 0; i < N; i++) {
  const m = adj.get(i);
  const c = m === undefined ? 0 : m.size;
  edgeCount += c;
  if (c === 0) isolated++;
}
edgeCount = Math.floor(edgeCount / 2);
console.log(
  `网：${N} 节点 / ${edgeCount} 边（引用边写入 ${refEdges} / 目录边写入 ${dirEdges}）/ 孤立节点 ${isolated}`,
);

// —— PPR：个性化 PageRank，重启分布 = 本查询的 BM25 种子归一化 ——
// p = α·s + (1−α)·Wᵀ p，W 行归一化（出边权重归一）。
function personalizedPageRank(seedVec) {
  let total = 0;
  for (let i = 0; i < N; i++) total += seedVec[i];
  if (total <= 0) return new Float64Array(N);
  const s = Float64Array.from(seedVec, (v) => v / total);
  let p = Float64Array.from(s);
  const next = new Float64Array(N);
  for (let it = 0; it < ITERS; it++) {
    next.fill(0);
    for (let i = 0; i < N; i++) {
      const pi = p[i];
      if (pi <= 0) continue;
      const m = adj.get(i);
      if (m === undefined || m.size === 0) {
        // 悬挂节点：能量均分回全网（避免质量泄漏）。
        const share = (pi * (1 - ALPHA)) / N;
        for (let k = 0; k < N; k++) next[k] += share;
        continue;
      }
      let wsum = 0;
      for (const w of m.values()) wsum += w;
      const factor = (pi * (1 - ALPHA)) / wsum;
      for (const [j, w] of m) next[j] += factor * w;
    }
    for (let i = 0; i < N; i++) p[i] = ALPHA * s[i] + next[i];
  }
  return p;
}

/** 硬 k-hop 邻域（对照：既有 graphSignal 的思路，但不用中心性排序）。 */
function hopNeighborhood(seedIdx, hops) {
  const visited = new Set(seedIdx);
  let frontier = [...seedIdx];
  for (let h = 0; h < hops; h++) {
    const next = [];
    for (const i of frontier) {
      const m = adj.get(i);
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

/** 融合权重（PPR 相对 BM25 归一化分的比重）；用于「实测可拿到」的排序。 */
const BETAS = [0, 0.25, 0.5, 1.0, 2.0];

const rows = [];
for (const { q, anchor } of QUERIES) {
  const gt = groundTruth(anchor);
  const qk = tokenize(q);

  // 旧口径：生产 query() 的深池排序（= 当前代码能给出的最深序）。
  const deep = query(corpus, q, { fileK: DEEP, rerank: false, prf: false }).files;
  let oldRank = Infinity;
  for (let i = 0; i < deep.length; i++) {
    if (gt.has(deep[i])) {
      oldRank = i + 1;
      break;
    }
  }

  // 种子：BM25 文件路原始分（与 query() 内部一致：fileIndex.search(qk, 20)）。
  const raw = [...corpus.fileIndex.search(qk, 20)];
  const seedVec = new Float64Array(N);
  let maxRaw = 0;
  for (const h of raw) maxRaw = Math.max(maxRaw, h.score);
  for (const h of raw) {
    const rel = corpus.files[h.id]?.rel;
    const i = rel === undefined ? undefined : nodeOf.get(rel);
    if (i === undefined) continue;
    seedVec[i] = maxRaw > 0 ? h.score / maxRaw : 0;
  }
  const seedIdx = [...seedVec.keys()].filter((i) => seedVec[i] > 0);

  // PPR 稳态 → 排序
  const ppr = personalizedPageRank(seedVec);
  const pprOrder = [...ppr.keys()].sort((a, b) => ppr[b] - ppr[a]);
  let pprRank = Infinity;
  for (let i = 0; i < pprOrder.length; i++) {
    if (gt.has(fileRels[pprOrder[i]])) {
      pprRank = i + 1;
      break;
    }
  }

  // 硬 k-hop 邻域覆盖（GT 是否落在邻域内）
  const reachByHop = {};
  for (const h of HOPS) {
    const nb = hopNeighborhood(seedIdx, h);
    let hit = false;
    for (const i of nb) {
      if (gt.has(fileRels[i])) {
        hit = true;
        break;
      }
    }
    reachByHop[h] = hit;
  }

  // 融合排序（BM25 归一 + β·PPR 归一），取各 β 下 GT 的最佳排位。
  let maxBm = 0;
  const bmVec = new Float64Array(N);
  for (const h of corpus.fileIndex.search(qk, 1000)) {
    const rel = corpus.files[h.id]?.rel;
    const i = rel === undefined ? undefined : nodeOf.get(rel);
    if (i === undefined) continue;
    bmVec[i] = h.score;
    maxBm = Math.max(maxBm, h.score);
  }
  let maxPpr = 0;
  for (let i = 0; i < N; i++) maxPpr = Math.max(maxPpr, ppr[i]);
  const fusedRank = {};
  for (const beta of BETAS) {
    const score = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      score[i] = (maxBm > 0 ? bmVec[i] / maxBm : 0) + beta * (maxPpr > 0 ? ppr[i] / maxPpr : 0);
    }
    const order = [...score.keys()].sort((a, b) => score[b] - score[a]);
    let r = Infinity;
    for (let i = 0; i < order.length; i++) {
      if (gt.has(fileRels[order[i]])) {
        r = i + 1;
        break;
      }
    }
    fusedRank[beta] = r;
  }

  const failure = oldRank <= 10 ? 'OK' : oldRank <= RANK_CAP ? 'RANKING' : 'LEXICAL';
  rows.push({
    q,
    anchor,
    gtSize: gt.size,
    failure,
    oldRank: Number.isFinite(oldRank) ? oldRank : null,
    pprRank: Number.isFinite(pprRank) ? pprRank : null,
    fusedRank: Object.fromEntries(
      Object.entries(fusedRank).map(([k, v]) => [k, Number.isFinite(v) ? v : null]),
    ),
    reach: reachByHop,
  });
}

const n = rows.length;
const pct = (c) => +((c / n) * 100).toFixed(1);

// —— oracle@D：旧池 vs PPR 排序 vs 融合排序 ——
const DEPTHS = [5, 10, 14, 20, 50, 100, 300];
const oracleOld = {};
const oraclePpr = {};
for (const D of DEPTHS) {
  oracleOld[D] = pct(rows.filter((r) => r.oldRank !== null && r.oldRank <= D).length);
  oraclePpr[D] = pct(rows.filter((r) => r.pprRank !== null && r.pprRank <= D).length);
}
const oracleFused = {};
for (const beta of BETAS) {
  oracleFused[beta] = {};
  for (const D of DEPTHS) {
    oracleFused[beta][D] = pct(
      rows.filter((r) => r.fusedRank[beta] !== null && r.fusedRank[beta] <= D).length,
    );
  }
}

// —— 硬邻域覆盖 ——
const reachRate = {};
for (const h of HOPS) reachRate[`hop${h}`] = pct(rows.filter((r) => r.reach[h]).length);

console.log('\n=== oracle 天花板对照（33 条查询，完美重排假设）===');
console.log('  D    BM25旧池   PPR单路   ' + BETAS.map((b) => `融合β=${b}`).join('  '));
for (const D of DEPTHS) {
  console.log(
    `  ${String(D).padStart(3)}   ${String(oracleOld[D]).padStart(6)}%   ${String(oraclePpr[D]).padStart(6)}%   ` +
      BETAS.map((b) => String(oracleFused[b][D]).padStart(8) + '%').join('  '),
  );
}

console.log('\n=== 硬 k-hop 邻域覆盖率（GT 是否落在种子邻域内）===');
for (const h of HOPS) console.log(`  ${h} 跳：${reachRate[`hop${h}`]}%`);

console.log('\n=== 失败查询明细（BM25 K=10 未命中）===');
for (const r of rows) {
  if (r.failure === 'OK') continue;
  console.log(
    `  [${r.failure.padEnd(7)}] oldRank=${String(r.oldRank ?? '∞').padStart(6)}  ` +
      `PPR=${String(r.pprRank ?? '∞').padStart(6)}  融合β=0.5:${String(r.fusedRank['0.5'] ?? '∞').padStart(6)}  ` +
      `hops=${
        HOPS.filter((h) => r.reach[h])
          .map((h) => h)
          .join('/') || 'none'
      }  "${r.q}"`,
  );
}

const lexicalRows = rows.filter((r) => r.failure === 'LEXICAL');
const rescuedByPpr = lexicalRows.filter((r) => r.pprRank !== null && r.pprRank <= 50).length;
const rescuedByHop = lexicalRows.filter((r) => r.reach[3]).length;

console.log('\n=== 词法盲区（LEXICAL）能否被网捞回 ===');
console.log(`  LEXICAL 共 ${lexicalRows.length} 条`);
console.log(`  其中 PPR 排序前 50 名内含 GT：${rescuedByPpr} 条`);
console.log(`  其中 3 跳硬邻域内含 GT      ：${rescuedByHop} 条`);

const report = {
  generatedAt: new Date().toISOString(),
  corpus: { files: N, symbols: corpus.symbols.length },
  graph: { edges: edgeCount, refEdges, dirEdges, isolated, maxDf: MAX_DF_FOR_EDGE },
  config: { ALPHA, ITERS, HOPS, BETAS, DEEP, RANK_CAP },
  queryCount: n,
  oracleOld,
  oraclePpr,
  oracleFused,
  reachRate,
  lexical: { total: lexicalRows.length, rescuedByPpr, rescuedByHop },
  rows,
};

writeFileSync(
  new URL('./spider-reach-probe.report.json', import.meta.url),
  JSON.stringify(report, null, 2),
);
console.log('\nWrote evals/spider-reach-probe.report.json');
