#!/usr/bin/env node
// 蜘蛛网「丝线显著性」扫描：把网从「处处等价」调成「有鉴别力的天网」。
//
// 动机（evals/spider-pool-ab.mjs 的负面实测）：
//   - 当前建网（df≤4 + 同目录边）得 482 节点 / 16034 边 / **平均度 66.5** ⇒ 1 跳邻域就吃掉全网 90.2%，
//     2 跳 100%。「100% 覆盖猎物」因此毫无意义 —— **网大到处处等价 = 没有鉴别力**。
//   - 直接后果：PPR 在如此稠密的图上迅速摊平（稳态接近均匀），扩张池 + 精排增益恰好 +0.0pp。
//
// 本次扫描两个稀疏化维度（其余不变）：
//   ① 稀有度阈值 maxDf：只有「出现在 ≤maxDf 个文件里」的共享标识符才配连边（越小越疏、越精确）。
//   ② 每节点度数上限 cap：每节点只保留权重最高的 cap 条边（含目录边），按 top-K 截断（0 = 不限）。
//
// 判据（同时看三件事，缺一不可）：
//   · **鉴别力**：1 跳邻域规模占全网比例 —— 越接近全网越无信息量（目标：≪ 50%）。
//   · **无漏网**：1 跳邻域对 GT 的覆盖率 —— 回应「无处躲藏」。
//   · **收益**：PPR 单路 oracle@14 是否超过 BM25 池的 60.6%/81.8% 口径；以及 LEXICAL 6 条的 GT 排位。
//
// 用法：node evals/spider-density-sweep.mjs
// 输出：evals/spider-density-sweep.report.json + 控制台摘要。

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

const corpus = indexCorpus(SRC, { morph: true, light: true });
const N = corpus.files.length;
console.log(`语料：${N} 文件 / ${corpus.symbols.length} 符号`);

function groundTruth(anchor) {
  const needle = anchor.toLowerCase();
  const set = new Set();
  for (const [rel, text] of corpus.fileText) {
    if (text.toLowerCase().includes(needle)) set.add(rel);
  }
  return set;
}

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

const gts = new Map();
for (const { q, anchor } of QUERIES) {
  const gt = groundTruth(anchor);
  if (gt.size === 0) throw new Error(`锚点不存在（GT=0）：query="${q}" anchor="${anchor}"`);
  gts.set(q, gt);
}

// —— 建网（可配置稀疏度）——
function buildGraph({ maxDf, dirWeight, cap }) {
  const rels = corpus.files.map((f) => f.rel);
  const nodeOf = new Map(rels.map((rel, i) => [rel, i]));

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

  /** 先收集每个节点的全部候选边（i → Map(j → w)），再统一按 cap 截断。 */
  const cand = new Map();
  const put = (i, j, w) => {
    if (i === j) return;
    let m = cand.get(i);
    if (m === undefined) {
      m = new Map();
      cand.set(i, m);
    }
    if (w > (m.get(j) ?? 0)) m.set(j, w);
  };

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
        put(i, j, w);
      }
    }
  }

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
    if (arr.length < 2 || arr.length > 40) continue;
    for (let a = 0; a < arr.length; a++) {
      for (let b = a + 1; b < arr.length; b++) {
        const i = nodeOf.get(arr[a]);
        const j = nodeOf.get(arr[b]);
        if (i === undefined || j === undefined) continue;
        const w = dirWeight;
        if (w <= 0) continue;
        put(i, j, w);
        put(j, i, w);
      }
    }
  }

  // 按权重 top-cap 截断每节点出边，再对称化（取并集：i 保留 j 则双向可见）。
  const kept = new Map();
  for (const [i, m] of cand) {
    let entries = [...m.entries()];
    if (cap > 0 && entries.length > cap) {
      entries = entries.sort((a, b) => b[1] - a[1]).slice(0, cap);
    }
    kept.set(i, entries);
  }
  const adj = new Map();
  for (const [i, entries] of kept) {
    for (const [j, w] of entries) {
      let mi = adj.get(i);
      if (mi === undefined) {
        mi = new Map();
        adj.set(i, mi);
      }
      if (w > (mi.get(j) ?? 0)) mi.set(j, w);
      let mj = adj.get(j);
      if (mj === undefined) {
        mj = new Map();
        adj.set(j, mj);
      }
      if (w > (mj.get(i) ?? 0)) mj.set(i, w);
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
  return { rels, nodeOf, adj, edges, isolated, avgDeg: +((2 * edges) / N).toFixed(1) };
}

function ppr(g, seedVec, alpha, iters = 30) {
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
      const m = g.adj.get(i);
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

/** 逐查询的 BM25 种子（与 query() 内部一致）。 */
function seedOf(g, q) {
  const seedVec = new Float64Array(N);
  const hits = [...corpus.fileIndex.search(tokenize(q), 20)];
  let max = 0;
  for (const h of hits) max = Math.max(max, h.score);
  for (const h of hits) {
    const rel = corpus.files[h.id]?.rel;
    const i = rel === undefined ? undefined : g.nodeOf.get(rel);
    if (i === undefined) continue;
    seedVec[i] = max > 0 ? h.score / max : 0;
  }
  const idx = [];
  for (let i = 0; i < N; i++) if (seedVec[i] > 0) idx.push(i);
  return { seedVec, idx };
}

/** 旧口径：生产 query() 深池里 GT 的最佳排位（= 词法池覆盖 81.8% 的来源）。 */
const oldRanks = new Map();
for (const { q } of QUERIES) {
  const deep = query(corpus, q, { fileK: DEEP, rerank: false, prf: false }).files;
  const gt = gts.get(q);
  let r = Infinity;
  for (let i = 0; i < deep.length; i++) {
    if (gt.has(deep[i])) {
      r = i + 1;
      break;
    }
  }
  oldRanks.set(q, r);
}

const MAXDFS = [1, 2, 3, 4];
const CAPS = [0, 8, 16];
const ALPHAS = [0.15, 0.3, 0.5];
const DEPTHS = [10, 14, 20, 50, 100];

const rows = [];
for (const maxDf of MAXDFS) {
  for (const cap of CAPS) {
    const g = buildGraph({ maxDf, dirWeight: 0.15, cap });
    // 种子与邻域规模
    const qdata = new Map();
    for (const { q } of QUERIES) {
      const { seedVec, idx } = seedOf(g, q);
      const nb = new Set(idx);
      let frontier = [...idx];
      for (let h = 0; h < 1; h++) {
        const nx = [];
        for (const i of frontier) {
          const m = g.adj.get(i);
          if (m === undefined) continue;
          for (const j of m.keys()) {
            if (!nb.has(j)) {
              nb.add(j);
              nx.push(j);
            }
          }
        }
        frontier = nx;
      }
      qdata.set(q, { seedVec, nb });
    }
    const hop1Avg = +(
      [...qdata.values()].reduce((a, v) => a + v.nb.size, 0) / QUERIES.length
    ).toFixed(1);
    const hop1Cov = +(
      (QUERIES.filter(({ q }) => {
        const gt = gts.get(q);
        for (const i of qdata.get(q).nb) if (gt.has(g.rels[i])) return true;
        return false;
      }).length /
        QUERIES.length) *
      100
    ).toFixed(1);

    for (const alpha of ALPHAS) {
      const oracles = {};
      for (const D of DEPTHS) oracles[D] = 0;
      let lexHits = 0;
      const lexTotal = QUERIES.filter(({ q }) => oldRanks.get(q) > 200).length;
      for (const { q } of QUERIES) {
        const { seedVec } = qdata.get(q);
        const p = ppr(g, seedVec, alpha);
        const order = [];
        for (let i = 0; i < N; i++) if (p[i] > 0) order.push(i);
        order.sort((a, b) => p[b] - p[a]);
        const gt = gts.get(q);
        let rank = Infinity;
        for (let i = 0; i < order.length; i++) {
          if (gt.has(g.rels[order[i]])) {
            rank = i + 1;
            break;
          }
        }
        for (const D of DEPTHS) if (rank <= D) oracles[D]++;
        if (oldRanks.get(q) > 200 && rank <= 100) lexHits++;
      }
      for (const D of DEPTHS) oracles[D] = +((oracles[D] / QUERIES.length) * 100).toFixed(1);
      rows.push({
        maxDf,
        cap,
        alpha,
        edges: g.edges,
        avgDeg: g.avgDeg,
        isolated: g.isolated,
        hop1Avg,
        hop1Pct: +((hop1Avg / N) * 100).toFixed(1),
        hop1Cov,
        oracle: oracles,
        lexicalRescued: lexHits,
        lexicalTotal: lexTotal,
      });
    }
  }
}

// 旧口径基线
const baseCov = +(
  (QUERIES.filter(({ q }) => oldRanks.get(q) <= DEEP).length / QUERIES.length) *
  100
).toFixed(1);
console.log(`\n旧口径（BM25 深池覆盖率，= 既有 81.8% 同源）：${baseCov}%`);

console.log('\n=== 稀疏度扫描（1 跳鉴别力 / 无漏网 / PPR 排序 oracle）===');
console.log(
  '  maxDf cap  α    边数  平均度 孤立 1跳均长(占全网) 1跳覆盖  o@10  o@14  o@20  o@50 o@100  LEXICAL捞回',
);
for (const r of rows) {
  console.log(
    `  ${String(r.maxDf).padStart(5)} ${String(r.cap).padStart(3)}  ${String(r.alpha).padStart(4)}  ` +
      `${String(r.edges).padStart(6)} ${String(r.avgDeg).padStart(6)} ${String(r.isolated).padStart(4)} ` +
      `${String(r.hop1Avg).padStart(9)}(${String(r.hop1Pct).padStart(5)}%) ${String(r.hop1Cov).padStart(6)}%  ` +
      `${String(r.oracle[10]).padStart(5)} ${String(r.oracle[14]).padStart(5)} ${String(r.oracle[20]).padStart(5)} ` +
      `${String(r.oracle[50]).padStart(5)} ${String(r.oracle[100]).padStart(5)}   ${r.lexicalRescued}/${r.lexicalTotal}`,
  );
}

// 选出「鉴别力最好（1跳占比最低）且无漏网（覆盖 100%）」的行
const valid = rows.filter((r) => r.hop1Cov >= 100);
const best = valid.slice().sort((a, b) => a.hop1Pct - b.hop1Pct)[0];
if (best !== undefined) {
  console.log(
    `\n★ 最优稀疏度（1 跳覆盖仍 100% 且邻域最小）：maxDf=${best.maxDf} cap=${best.cap} ` +
      `⇒ 1 跳均长 ${best.hop1Avg}（占全网 ${best.hop1Pct}%）/ 边 ${best.edges} / 平均度 ${best.avgDeg} / 孤立 ${best.isolated}`,
  );
}

const report = {
  generatedAt: new Date().toISOString(),
  corpus: { files: N, symbols: corpus.symbols.length },
  oldPoolCoverage: baseCov,
  config: { MAXDFS, CAPS, ALPHAS, DEPTHS, DEEP },
  rows,
  best: best ?? null,
};
writeFileSync(
  new URL('./spider-density-sweep.report.json', import.meta.url),
  JSON.stringify(report, null, 2),
);
console.log('\nWrote evals/spider-density-sweep.report.json');
