#!/usr/bin/env node
// 蜘蛛网「中央捕食」两式对照：网只负责**兜住漏网之鱼**，中央只负责**锁死**。
//
// 前序实测（evals/spider-pool-ab.mjs / spider-density-sweep.mjs）已证伪两条路：
//   ① 「网当独立检索信号」（PPR 单路排序）：浅层 o@14 最高 51.5% < BM25 池 60.6% —— 全面劣于词法。
//   ② 「扩张候选池 + 既有一阶段精排」：+0.0pp（N 从 10 到 80 纹丝不动）。
//      根因：PPR 兜来的新猎物**零词法交集**，而精排器只有「倒数秩 + 符号名覆盖率」两项 ⇒ 对它们全盲。
//
// 本次对照两个**结构性**不同的用法（都不重排已有猎物）：
//   A. **配额保留**（quota）：留 q 个 Top-K 名额，专给「网黏来的新猎物」（PPR 排序中不在 BM25 池的高分文件）。
//      —— 蜘蛛不改变已爬在网上猎物的次序，只在网中央专捕撞进来的。
//   B. **蜘蛛能量项**（energy）：把 PPR 稳态分作为精排的**第三项信号**（γ·能量），
//      使「零词法交集但网邻近」的文件能自然浮起，无需硬占名额。
//
// 判据：hitRate@K 的 bootstrap 95% CI 下界须 > 基线（q=0 / γ=0，= 生产 BM25 池 + 精排）。
// 同时报告：LEXICAL 6 条的捞回数、跨查询 Top-K 重合度（否决器，>0.7 即常量偏置）。
//
// 用法：node evals/spider-quota-ab.mjs
// 输出：evals/spider-quota-ab.report.json + 控制台摘要。

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
const { FileRerankIndex } = await importDist('context', 'fileRerankIndex.js');
const { buildSpiderGraph, personalizedPageRank, bm25Seed, pprOrder } = await import(
  pathToFileURL(join(__dirname, 'lib', 'spider-graph.mjs')).href
);

const SRC = join(ROOT, 'src');
const DEEP = 600;
const K = 14;
const QUOTAS = [0, 1, 2, 3, 4, 6];
const GAMMAS = [0, 0.02, 0.05, 0.1, 0.2];
/** 网配置候选（由 evals/spider-density-sweep.mjs 选出：兼顾鉴别力与不漏网）。 */
const GRAPH_CFGS = [
  { maxDf: 1, dirWeight: 0.15, cap: 0, alpha: 0.15 },
  { maxDf: 1, dirWeight: 0.15, cap: 0, alpha: 0.5 },
  { maxDf: 4, dirWeight: 0.15, cap: 0, alpha: 0.15 },
  { maxDf: 4, dirWeight: 0.15, cap: 0, alpha: 0.5 },
  { maxDf: 1, dirWeight: 0.15, cap: 8, alpha: 0.15 },
];

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
  { q: 'tuning knobs for the graph that links distant memories', anchor: 'CosmicWebOptions' },
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

// —— 每查询预算（与网配置无关的部分）——
const basePool = new Map();
const bm25PoolRank = new Map();
for (const { q } of QUERIES) {
  const pool = query(corpus, q, { fileK: DEEP, rerank: false, prf: false }).files;
  basePool.set(q, pool);
  let r = Infinity;
  const gt = gts.get(q);
  for (let i = 0; i < pool.length; i++) {
    if (gt.has(pool[i])) {
      r = i + 1;
      break;
    }
  }
  bm25PoolRank.set(q, r);
}

const reranker = new FileReranker();
const rerankIndex = new FileRerankIndex();

function metrics(files, gt) {
  const hits = files.filter((f) => gt.has(f)).length;
  return {
    hits,
    hit: hits > 0 ? 1 : 0,
    precision: files.length ? hits / files.length : 0,
    recall: gt.size ? hits / gt.size : 0,
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

function crossQueryOverlap(filesByQuery) {
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

const lexicalQueries = QUERIES.filter(({ q }) => bm25PoolRank.get(q) > 200).map(({ q }) => q);
console.log(`词法盲区（BM25 深池内不含 GT）查询数：${lexicalQueries.length}`);

const rows = [];
for (const cfg of GRAPH_CFGS) {
  const g = buildSpiderGraph(corpus, tokenize, { maxDf: cfg.maxDf, dirWeight: cfg.dirWeight });
  // 每节点度数上限截断（cap>0 时）
  let graph = g;
  if (cfg.cap > 0) {
    const adj = new Map();
    for (const [i, m] of g.adj) {
      const entries = [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, cfg.cap);
      adj.set(i, new Map(entries));
    }
    graph = { ...g, adj };
  }

  const perQ = new Map();
  for (const { q } of QUERIES) {
    const { seedVec } = bm25Seed(corpus, tokenize(q), graph);
    const p = personalizedPageRank(graph, seedVec, { alpha: cfg.alpha });
    const order = pprOrder(graph, p);
    let maxP = 0;
    for (let i = 0; i < graph.N; i++) maxP = Math.max(maxP, p[i]);
    const poolSet = new Set(basePool.get(q));
    const fresh = order.filter((rel) => !poolSet.has(rel));
    perQ.set(q, { p, order, fresh, maxP, nodeOf: graph.nodeOf });
  }

  // —— A 配额保留 ——
  for (const quota of QUOTAS) {
    const hitRates = [];
    const precisions = [];
    const recalls = [];
    const filesByQuery = new Map();
    let lexRescued = 0;
    for (const { q } of QUERIES) {
      const gt = gts.get(q);
      const pool = basePool.get(q);
      const fresh = perQ.get(q).fresh;
      const keep = Math.max(0, K - quota);
      const head = reranker.rerank({ corpus, query: q, candidates: pool, fileK: keep }).files;
      const files = [...head, ...fresh.slice(0, Math.min(quota, K))].slice(0, K);
      const m = metrics(files, gt);
      hitRates.push(m.hit);
      precisions.push(m.precision);
      recalls.push(m.recall);
      filesByQuery.set(q, files);
      if (m.hit === 1 && lexicalQueries.includes(q)) lexRescued++;
    }
    rows.push({
      kind: 'quota',
      cfg,
      param: quota,
      hitRate: bootstrapCI(hitRates),
      precision: bootstrapCI(precisions),
      recall: bootstrapCI(recalls),
      overlap: crossQueryOverlap(filesByQuery),
      lexRescued,
      lexTotal: lexicalQueries.length,
    });
  }

  // —— B 蜘蛛能量项 ——
  const termsOf = new Map();
  for (const { q } of QUERIES) termsOf.set(q, rerankIndex.contentTerms(corpus, q));
  for (const gamma of GAMMAS) {
    const hitRates = [];
    const precisions = [];
    const recalls = [];
    const filesByQuery = new Map();
    let lexRescued = 0;
    for (const { q } of QUERIES) {
      const gt = gts.get(q);
      const pool = basePool.get(q);
      const { p, order, maxP, nodeOf: nodeIndex } = perQ.get(q);
      // 候选 = BM25 池 ∪ 网 top-60（限规模，避免噪声淹没有限名额）
      const poolSet = new Set(pool);
      const extra = order.filter((rel) => !poolSet.has(rel)).slice(0, 60);
      const cands = [...pool, ...extra];
      const terms = termsOf.get(q);
      const scored = cands.map((rel, i) => {
        const rank = i + 1;
        let coverage = 0;
        if (terms.length > 0) {
          const names = rerankIndex.nameTerms(corpus, rel);
          let total = 0;
          let covered = 0;
          for (const t of terms) {
            const w = rerankIndex.weight(corpus, t);
            total += w;
            if (names.has(t)) covered += w;
          }
          coverage = total > 0 ? covered / total : 0;
        }
        const ni = nodeIndex.get(rel);
        const energy = ni === undefined || maxP <= 0 ? 0 : p[ni] / maxP;
        return { rel, rank, score: 1 / (1 + rank) + coverage + gamma * energy };
      });
      scored.sort((a, b) => b.score - a.score || a.rank - b.rank);
      const files = scored.slice(0, K).map((s) => s.rel);
      const m = metrics(files, gt);
      hitRates.push(m.hit);
      precisions.push(m.precision);
      recalls.push(m.recall);
      filesByQuery.set(q, files);
      if (m.hit === 1 && lexicalQueries.includes(q)) lexRescued++;
    }
    rows.push({
      kind: 'energy',
      cfg,
      param: gamma,
      hitRate: bootstrapCI(hitRates),
      precision: bootstrapCI(precisions),
      recall: bootstrapCI(recalls),
      overlap: crossQueryOverlap(filesByQuery),
      lexRescued,
      lexTotal: lexicalQueries.length,
    });
  }
}

const label = (cfg) => `df≤${cfg.maxDf} cap=${cfg.cap} α=${cfg.alpha}`;
console.log(`\n=== 中央捕食两式对照（K=${K}，基线 = 配额 0 / 能量 0 = 生产 BM25 池+精排）===`);
for (const cfg of GRAPH_CFGS) {
  const sub = rows.filter((r) => r.cfg === cfg);
  const base = sub.find((r) => r.kind === 'quota' && r.param === 0);
  console.log(
    `\n  网：${label(cfg)}   （基线命中率 ${base.hitRate.mean}% [${base.hitRate.lo}, ${base.hitRate.hi}]）`,
  );
  console.log(
    '  式      参数   命中率[95%CI]                 Δ       准确度   召回   重合度  LEXICAL',
  );
  for (const r of sub) {
    const delta =
      r.param === 0
        ? ''
        : `${r.hitRate.mean - base.hitRate.mean >= 0 ? '+' : ''}${(r.hitRate.mean - base.hitRate.mean).toFixed(1)}pp`;
    console.log(
      `  ${r.kind.padEnd(7)} ${String(r.param).padStart(4)}   ` +
        `${String(r.hitRate.mean).padStart(5)}% [${String(r.hitRate.lo).padStart(4)}, ${String(r.hitRate.hi).padStart(4)}]  ` +
        `${delta.padEnd(8)}  ${String(r.precision.mean).padStart(5)}%  ${String(r.recall.mean).padStart(5)}%  ` +
        `${String(r.overlap).padStart(5)}   ${r.lexRescued}/${r.lexTotal}`,
    );
  }
}

const report = {
  generatedAt: new Date().toISOString(),
  corpus: { files: corpus.files.length, symbols: corpus.symbols.length },
  K,
  queryCount: QUERIES.length,
  lexicalQueries: lexicalQueries.length,
  config: { QUOTAS, GAMMAS, GRAPH_CFGS },
  rows,
};
writeFileSync(
  new URL('./spider-quota-ab.report.json', import.meta.url),
  JSON.stringify(report, null, 2),
);
console.log('\nWrote evals/spider-quota-ab.report.json');
