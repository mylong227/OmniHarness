#!/usr/bin/env node
// 蜘蛛网「天网」扩张池 AB：网负责**够到猎物**（无处躲藏），中央蜘蛛负责**锁死猎物**（精排）。
//
// 设计动机（用户诉求 + 实测）：
//   - 用户：「网如天网无处不在，无处躲藏」「能在中央精确抓住猎物」「突破理论值」。
//   - 实测（evals/spider-reach-probe.mjs）：BM25 候选池对 33 条查询只覆盖 81.8%（= 旧理论值，
//     即「池里到底有没有答案」）；而网 1 跳邻域覆盖 **100%**；PPR 排序 D=100 时可达 84.8%、
//     D=300 时 97% ⇒ 网的**可达集严格大于**词法池，这才是「突破理论值」的实质。
//   - 但浅层（D≤20）PPR 单路/线性融合**都低于** BM25 —— 能量被摊薄到全网，精度被稀释。
//     ⇒ 正确形态是「**只扩张候选池、不改 BM25 排序地板**」，再交给既有零依赖精排器锁死。
//
// 本脚本度量该形态的真实收益（33 条锚点查询，真实 src/ 语料，免网络免模型）：
//   变体：PPR 新增候选数 N ∈ {0,10,20,40,80} × 文件预算 K ∈ {10,14,20}，重启 α ∈ {0.15,0.3,0.5}
//   基线 = N=0（= 生产 BM25 池 + 精排，即 P1 档）
//   指标 = hitRate / precision / recall / MRR + bootstrap 95% CI
//   否决器 = 跨查询 Top-K 平均成对重合度（既有图方案 0.936 = 常量偏置；BM25 仅 0.058）
//   鉴别力 = 邻域规模占全网比例（覆盖率 100% 若因邻域退化成全图，则无意义 —— 必须同时报告）
//
// 诚实纪律：锚点不存在直接失败；不报无 CI 的点估计；翻默认须 CI 下界 > 基线。
//
// 用法：node evals/spider-pool-ab.mjs
// 输出：evals/spider-pool-ab.report.json + 控制台摘要。

import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { writeFileSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const DIST = join(ROOT, 'dist', 'src');
const importDist = (...segments) => import(pathToFileURL(join(DIST, ...segments)).href);

const { indexCorpus, query } = await importDist('context', 'contextEngine.js');
const { tokenize } = await importDist('search', 'bm25Index.js');
const { FileReranker } = await importDist('context', 'fileReranker.js');
const { buildSpiderGraph, personalizedPageRank, hopNeighborhood, bm25Seed, pprOrder } =
  await import(pathToFileURL(join(__dirname, 'lib', 'spider-graph.mjs')).href);

const SRC = join(ROOT, 'src');
const DEEP = 600;
const NS = [0, 10, 20, 40, 80];
const KS = [10, 14, 20];
const ALPHAS = [0.15, 0.3, 0.5];

const corpus = indexCorpus(SRC, { morph: true, light: true });
const g = buildSpiderGraph(corpus, tokenize);
console.log(
  `语料：${corpus.files.length} 文件 / ${corpus.symbols.length} 符号  |  ` +
    `网：${g.N} 节点 / ${g.edges} 边 / 平均度 ${g.avgDeg} / 孤立节点 ${g.isolated}`,
);

function groundTruth(anchor) {
  const needle = anchor.toLowerCase();
  const set = new Set();
  for (const [rel, text] of corpus.fileText) {
    if (text.toLowerCase().includes(needle)) set.add(rel);
  }
  return set;
}

// 33 条查询（与 recall-precision.mjs / headroom-analysis.mjs / spider-reach-probe.mjs 同源）。
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
  if (gt.size === 0) throw new Error(`锚点在语料中不存在（GT=0）：query="${q}" anchor="${anchor}"`);
  gts.set(q, gt);
}

const reranker = new FileReranker();

// —— 逐查询预算：BM25 池 / 种子 / PPR（按 α 缓存）/ 邻域规模 ——
const perQuery = new Map();
for (const { q } of QUERIES) {
  const pool = query(corpus, q, { fileK: DEEP, rerank: false, prf: false }).files;
  const qk = tokenize(q);
  const { seedVec, seedIdx } = bm25Seed(corpus, qk, g);
  const pprByAlpha = {};
  for (const alpha of ALPHAS) {
    pprByAlpha[alpha] = pprOrder(g, personalizedPageRank(g, seedVec, { alpha }));
  }
  const hopSizes = {};
  for (const h of [1, 2, 3]) hopSizes[h] = hopNeighborhood(g, seedIdx, h).size;
  // 网上「不是词法池但被网黏住」的新猎物，按 PPR 降序。
  const freshByAlpha = {};
  for (const alpha of ALPHAS) {
    const poolSet = new Set(pool);
    freshByAlpha[alpha] = pprByAlpha[alpha].filter((rel) => !poolSet.has(rel));
  }
  perQuery.set(q, { pool, seedIdx, hopSizes, freshByAlpha, pprByAlpha });
}

// —— 邻域规模与覆盖（回应「天网无处不在」的鉴别力检验）——
const avgHop = {};
for (const h of [1, 2, 3]) {
  const sizes = [...perQuery.values()].map((v) => v.hopSizes[h]);
  avgHop[h] = +(sizes.reduce((a, b) => a + b, 0) / sizes.length).toFixed(1);
}
const hopCoverage = {};
for (const h of [1, 2, 3]) {
  const c = QUERIES.filter(({ q }) => {
    const gt = gts.get(q);
    for (const i of hopNeighborhood(g, perQuery.get(q).seedIdx, h)) {
      if (gt.has(g.rels[i])) return true;
    }
    return false;
  }).length;
  hopCoverage[h] = +((c / QUERIES.length) * 100).toFixed(1);
}

console.log('\n=== 天网覆盖面 vs 鉴别力（平均邻域规模 / 全网 482 文件）===');
for (const h of [1, 2, 3]) {
  console.log(
    `  ${h} 跳邻域：平均 ${String(avgHop[h]).padStart(5)} 文件（占全网 ${((avgHop[h] / g.N) * 100).toFixed(1)}%）` +
      `   覆盖 GT：${hopCoverage[h]}%`,
  );
}

// —— 变体扫描 ——
function measure(q, K, N, alpha) {
  const gt = gts.get(q);
  const { pool, freshByAlpha } = perQuery.get(q);
  const fresh = freshByAlpha[alpha];
  const cands = N > 0 ? [...pool, ...fresh.slice(0, N)] : pool;
  const files = reranker.rerank({ corpus, query: q, candidates: cands, fileK: K }).files;
  const hits = files.filter((f) => gt.has(f)).length;
  return {
    files,
    hits,
    recall: gt.size ? hits / gt.size : 0,
    precision: files.length ? hits / files.length : 0,
    hit: hits > 0 ? 1 : 0,
    poolSize: cands.length,
  };
}

function bootstrapCI(values, B = 2000) {
  const n = values.length;
  if (n === 0) return { mean: 0, lo: 0, hi: 0 };
  const means = [];
  let seed = 0x9e3779b9;
  const rnd = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 0xffffffff;
  };
  for (let b = 0; b < B; b++) {
    let s = 0;
    for (let i = 0; i < n; i++) s += values[Math.floor(rnd() * n)];
    means.push(s / n);
  }
  means.sort((a, b) => a - b);
  const mean = values.reduce((a, b) => a + b, 0) / n;
  return {
    mean: +(mean * 100).toFixed(1),
    lo: +(means[Math.floor(B * 0.025)] * 100).toFixed(1),
    hi: +(means[Math.floor(B * 0.975)] * 100).toFixed(1),
  };
}

/** 跨查询 Top-K 平均成对重合度（否决器：>0.7 视为常量偏置）。 */
function crossQueryOverlap(filesByQuery, K) {
  const sets = [...filesByQuery.values()].map((f) => new Set(f.slice(0, K)));
  let sum = 0;
  let pairs = 0;
  for (let i = 0; i < sets.length; i++) {
    for (let j = i + 1; j < sets.length; j++) {
      let inter = 0;
      for (const x of sets[i]) if (sets[j].has(x)) inter++;
      sum += inter / K;
      pairs++;
    }
  }
  return pairs === 0 ? 0 : +(sum / pairs).toFixed(3);
}

const results = [];
for (const alpha of ALPHAS) {
  for (const N of NS) {
    for (const K of KS) {
      const hitRates = [];
      const precisions = [];
      const recalls = [];
      const filesByQuery = new Map();
      const poolSizes = [];
      for (const { q } of QUERIES) {
        const m = measure(q, K, N, alpha);
        hitRates.push(m.hit);
        precisions.push(m.precision);
        recalls.push(m.recall);
        poolSizes.push(m.poolSize);
        filesByQuery.set(q, m.files);
      }
      results.push({
        alpha,
        N,
        K,
        hitRate: bootstrapCI(hitRates),
        precision: bootstrapCI(precisions),
        recall: bootstrapCI(recalls),
        overlap: crossQueryOverlap(filesByQuery, K),
        avgPool: +(poolSizes.reduce((a, b) => a + b, 0) / poolSizes.length).toFixed(1),
      });
    }
  }
}

console.log('\n=== 扩张池 AB（基线 N=0 = 生产 BM25 池 + 精排）===');
for (const alpha of ALPHAS) {
  console.log(`\n  α=${alpha}`);
  console.log('   K    N   命中率[95%CI]                准确度   召回    池均长  重合度');
  for (const r of results.filter((x) => x.alpha === alpha)) {
    const base = results.find((x) => x.alpha === alpha && x.N === 0 && x.K === r.K);
    const delta =
      r.N === 0
        ? ''
        : `  (${r.hitRate.mean - base.hitRate.mean >= 0 ? '+' : ''}${(r.hitRate.mean - base.hitRate.mean).toFixed(1)}pp)`;
    console.log(
      `  ${String(r.K).padStart(2)}  ${String(r.N).padStart(3)}   ` +
        `${String(r.hitRate.mean).padStart(5)}% [${String(r.hitRate.lo).padStart(4)}, ${String(r.hitRate.hi).padStart(4)}]${delta.padEnd(12)}` +
        `  ${String(r.precision.mean).padStart(5)}%  ${String(r.recall.mean).padStart(5)}%  ` +
        `${String(r.avgPool).padStart(5)}   ${r.overlap}`,
    );
  }
}

const report = {
  generatedAt: new Date().toISOString(),
  corpus: { files: corpus.files.length, symbols: corpus.symbols.length },
  graph: { nodes: g.N, edges: g.edges, avgDeg: g.avgDeg, isolated: g.isolated },
  netCoverage: { avgHop, hopCoverage },
  queryCount: QUERIES.length,
  config: { NS, KS, ALPHAS, DEEP },
  results,
};

writeFileSync(
  new URL('./spider-pool-ab.report.json', import.meta.url),
  JSON.stringify(report, null, 2),
);
console.log('\nWrote evals/spider-pool-ab.report.json');
