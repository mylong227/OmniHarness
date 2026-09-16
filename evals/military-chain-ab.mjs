#!/usr/bin/env node
// 军事链条多级检索 AB 度量（免网络、免模型、零依赖）。
//
// 把用户的军事比喻逐级翻译成可测的算法原语：
//   ① 最先进雷达探测   → 多字段 BM25F（content / path / symbols / signature 四频段并行扫描）
//   ② 太空卫星扫描定位 → 跨频段分数校准（max-norm / 分位数归一化 = 全域统一坐标）
//   ③ 高精度导弹命中   → 字段感知精排（倒数秩 + 符号名覆盖 + 路径覆盖三信号）
//   ④ 暴雨梨花针       → RRF 多探针融合（一发多针，天然免疫量纲）
//   ⑤ 高射速近防炮     → 末端补射 + 自适应预算（按分数断崖截断，降 token 保命中）
//
// 诚实纪律（沿用 recall-precision.mjs）：
//   - 锚点必须真实存在于语料（GT≥1），否则直接失败。
//   - 报告 bootstrap 95% CI（B=2000），不报点估计；判定看 CI 下界。
//   - 基线口径 = 生产当前默认 `query(fileK=14, rerank=true)`（对抗口径 69.7%）。
//   - **同时度量注入 token**（精确复现 outlineText 组装），支持「等 token 命中率」对比。
//
// 用法：
//   node evals/military-chain-ab.mjs            # 全量
//   node evals/military-chain-ab.mjs --quick    # 仅单字段与核心组合
// 输出：evals/military-chain-ab.report.json + 控制台摘要。

import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { writeFileSync, appendFileSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const DIST = join(ROOT, 'dist', 'src');
const importDist = (...segments) => import(pathToFileURL(join(DIST, ...segments)).href);

const PLOG = join(ROOT, 'military-chain-progress.log');
writeFileSync(PLOG, `start ${new Date().toISOString()}\n`);
const log = (m) => appendFileSync(PLOG, m + '\n');

const { indexCorpus, query } = await importDist('context', 'contextEngine.js');
const { Bm25Index, tokenize, tokenizeExpanded } = await importDist('search', 'bm25Index.js');
const { outlineText } = await importDist('context', 'repoMap.js');

const SRC = join(ROOT, 'src');
const KS = [5, 10, 14, 20];
const QUICK = process.argv.includes('--quick');

// ── 33 条已核实锚点查询（与 recall-precision.mjs 同源，刻意避开锚点字面词） ──
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

const corpus = indexCorpus(SRC, { morph: true, light: true });
const rels = corpus.files.map((f) => f.rel);
const N = rels.length;
log(`corpus: ${N} files, ${corpus.symbols.length} symbols`);

function groundTruth(anchor) {
  const needle = anchor.toLowerCase();
  const set = new Set();
  for (const [rel, text] of corpus.fileText) {
    if (text.toLowerCase().includes(needle)) set.add(rel);
  }
  return set;
}
const GTS = QUERIES.map(({ anchor }) => groundTruth(anchor));
QUERIES.forEach(({ q, anchor }, i) => {
  if (GTS[i].size === 0) throw new Error(`锚点不存在（GT=0）：query="${q}" anchor="${anchor}"`);
});

// ── 字段视图：@1 雷达的四个频段 ──
const byFile = new Map();
for (const s of corpus.symbols) {
  const arr = byFile.get(s.file);
  if (arr === undefined) byFile.set(s.file, [s]);
  else arr.push(s);
}
const FIELDS = ['content', 'path', 'symbols', 'signature'];
const fieldDocs = { content: [], path: [], symbols: [], signature: [] };
for (const rel of rels) {
  const text = corpus.fileText.get(rel) ?? '';
  fieldDocs.content.push(tokenize(text));
  fieldDocs.path.push(tokenizeExpanded(rel));
  const syms = byFile.get(rel) ?? [];
  fieldDocs.symbols.push(syms.flatMap((s) => tokenizeExpanded(s.name)));
  fieldDocs.signature.push(syms.flatMap((s) => tokenizeExpanded(s.signature)));
}
const fieldIndex = {};
for (const f of FIELDS) {
  const ix = new Bm25Index();
  ix.addDocuments(fieldDocs[f]);
  fieldIndex[f] = ix;
}

/** 单字段 BM25 分数向量（全量 N 维）。 */
function scoreVec(ix, qk) {
  const arr = new Float64Array(N);
  for (const h of ix.search(qk, N)) arr[h.id] = h.score;
  return arr;
}

const qkOf = QUERIES.map(({ q }) => tokenizeExpanded(q));
const rawVec = {};
for (const f of FIELDS) rawVec[f] = qkOf.map((qk) => scoreVec(fieldIndex[f], qk));

/** max 归一化（@2 卫星标定：把各频段回波拉到同一量纲）。 */
function maxNorm(v) {
  let m = 0;
  for (const x of v) if (x > m) m = x;
  if (m === 0) return v;
  const out = new Float64Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] / m;
  return out;
}

/** 排名分位数归一化（分布中位数在 0.5 处，对长尾更稳健）。 */
function rankNorm(v) {
  const idx = [...v.keys()].filter((i) => v[i] > 0).sort((a, b) => v[b] - v[a]);
  const out = new Float64Array(v.length);
  const denom = Math.max(1, idx.length - 1);
  idx.forEach((i, r) => {
    out[i] = 1 - r / denom;
  });
  return out;
}

const normed = {};
for (const f of FIELDS) {
  normed[f] = rawVec[f].map(maxNorm);
  normed[`${f}_rank`] = rawVec[f].map(rankNorm);
}
log('field vectors ready');

/** 加权求和融合。 */
function fuseSum(qi, weights, norm) {
  const table = norm === 'rank' ? normed : normed;
  const v = new Float64Array(N);
  for (const f of FIELDS) {
    const w = weights[f] ?? 0;
    if (w === 0) continue;
    const nv = norm === 'rank' ? table[`${f}_rank`][qi] : table[f][qi];
    for (let i = 0; i < N; i++) v[i] += w * nv[i];
  }
  return v;
}

/** RRF 融合（@4 暴雨梨花针：名次倒数计分，天然免疫量纲）。 */
function fuseRrf(qi, weights, k = 60) {
  const v = new Float64Array(N);
  for (const f of FIELDS) {
    const w = weights[f] ?? 0;
    if (w === 0) continue;
    const vec = rawVec[f][qi];
    const order = [...vec.keys()].filter((i) => vec[i] > 0).sort((a, b) => vec[b] - vec[a]);
    for (let r = 0; r < order.length; r++) v[order[r]] += w / (k + r + 1);
  }
  return v;
}

function topKOf(v, K) {
  const order = [...v.keys()].filter((i) => v[i] > 0).sort((a, b) => v[b] - v[a]);
  return order.slice(0, K).map((i) => rels[i]);
}

/** 注入 token（精确复现 query() 的 outline 组装；sigLines 为固定 30 行不随 K 变）。 */
const SIG_LINE_CONST = 30;
function outlineTokens(files) {
  const fileSet = new Set(files);
  const outline = outlineText(corpus.symbols.filter((s) => fileSet.has(s.file)));
  return tokenize(outline).length + SIG_LINE_CONST;
}

function ci(values, B = 2000) {
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
    mean: +mean.toFixed(4),
    lo: +means[Math.floor(B * 0.025)].toFixed(4),
    hi: +means[Math.floor(B * 0.975)].toFixed(4),
  };
}

/** rankFn(qi, K) → 文件列表；同时给出 metrics。 */
function evaluate(name, rankFn, Ks = KS) {
  const perK = {};
  for (const K of Ks) {
    const hits = [];
    const precs = [];
    const recs = [];
    const mrrs = [];
    const toks = [];
    const fails = [];
    for (let qi = 0; qi < QUERIES.length; qi++) {
      const files = rankFn(qi, K);
      const gt = GTS[qi];
      const hc = files.filter((f) => gt.has(f)).length;
      hits.push(hc > 0 ? 1 : 0);
      if (hc === 0) fails.push(QUERIES[qi].anchor);
      precs.push(files.length ? hc / files.length : 0);
      recs.push(gt.size ? hc / gt.size : 0);
      let rank = -1;
      for (let i = 0; i < files.length; i++) {
        if (gt.has(files[i])) {
          rank = i + 1;
          break;
        }
      }
      mrrs.push(rank > 0 ? 1 / rank : 0);
      toks.push(outlineTokens(files));
    }
    perK[K] = {
      hitRate: ci(hits),
      precision: ci(precs),
      recall: ci(recs),
      mrr: ci(mrrs),
      tokens: Math.round(toks.reduce((a, b) => a + b, 0) / toks.length),
      fails,
    };
  }
  return { name, perK };
}

/** 跨查询 Top-K 重合度（否决器：>0.9 视为常量偏置）。 */
function crossQueryOverlap(rankFn, K = 14) {
  let sum = 0;
  let cnt = 0;
  for (let a = 0; a < QUERIES.length; a++) {
    const sa = new Set(rankFn(a, K));
    for (let b = a + 1; b < QUERIES.length; b++) {
      const sb = rankFn(b, K);
      let inter = 0;
      for (const f of sb) if (sa.has(f)) inter++;
      sum += inter / Math.max(1, K);
      cnt++;
    }
  }
  return cnt ? +(sum / cnt).toFixed(3) : 0;
}

const results = [];
const fmt = (r, K) => {
  const p = r.perK[K];
  return (
    `${r.name.padEnd(34)} K=${String(K).padStart(2)}  ` +
    `命中率=${(p.hitRate.mean * 100).toFixed(1)}%[${(p.hitRate.lo * 100).toFixed(1)},${(p.hitRate.hi * 100).toFixed(1)}]  ` +
    `P=${(p.precision.mean * 100).toFixed(1)}%  recall=${(p.recall.mean * 100).toFixed(1)}%  ` +
    `MRR=${p.mrr.mean.toFixed(3)}  tok=${p.tokens}`
  );
};
const push = (r) => {
  results.push(r);
  for (const K of Object.keys(r.perK)) console.log(fmt(r, K));
  console.log('');
};

// ── V0 生产当前默认（口径基线） ──
log('V0 production default');
push(
  evaluate('V0 生产默认 fileK=14+rerank', (qi, K) => [
    ...query(corpus, QUERIES[qi].q, { fileK: K, rerank: true }).files,
  ]),
);

// ── V1 现有单字段 BM25（第一段） ──
log('V1 single-field');
push(
  evaluate('V1 单字段 BM25（第一段）', (qi, K) => [
    ...query(corpus, QUERIES[qi].q, { fileK: K, rerank: false }).files,
  ]),
);

// ── V2 单字段逐频段独立测（探测哪些频段真有信号） ──
for (const f of FIELDS) {
  log(`V2 field-only ${f}`);
  push(evaluate(`V2 仅${f}频段`, (qi, K) => topKOf(maxNorm(rawVec[f][qi]), K)));
}

// ── V3 多字段加权（@1+@2） ──
const combs = QUICK
  ? [{ content: 1, path: 2, symbols: 4, signature: 1 }]
  : [
      { content: 1, path: 1, symbols: 1, signature: 0 },
      { content: 1, path: 2, symbols: 2, signature: 0 },
      { content: 1, path: 2, symbols: 4, signature: 0 },
      { content: 1, path: 2, symbols: 4, signature: 1 },
      { content: 1, path: 4, symbols: 4, signature: 1 },
      { content: 1, path: 4, symbols: 8, signature: 2 },
      { content: 1, path: 8, symbols: 8, signature: 0 },
      { content: 1, path: 0, symbols: 4, signature: 0 },
    ];
for (const w of combs) {
  log(`V3 multi-field ${JSON.stringify(w)}`);
  push(
    evaluate(
      `V3 多字段Σ ${JSON.stringify(w)}`,
      (qi, K) => topKOf(fuseSum(qi, w, 'max'), K),
      [14, 20],
    ),
  );
}

// ── V4 分位数标定（@2 卫星：对长尾更稳健的坐标） ──
for (const w of [{ content: 1, path: 2, symbols: 4, signature: 1 }]) {
  log(`V4 rank-norm ${JSON.stringify(w)}`);
  push(
    evaluate(
      `V4 分位标定 ${JSON.stringify(w)}`,
      (qi, K) => topKOf(fuseSum(qi, w, 'rank'), K),
      [14, 20],
    ),
  );
}

// ── V5 RRF 多探针（@4 暴雨梨花针） ──
const rrfCombos = QUICK
  ? [{ content: 1, path: 2, symbols: 3, signature: 1 }]
  : [
      { content: 1, path: 1, symbols: 1, signature: 1 },
      { content: 1, path: 2, symbols: 3, signature: 1 },
      { content: 3, path: 2, symbols: 3, signature: 1 },
      { content: 1, path: 2, symbols: 3, signature: 0 },
    ];
for (const w of rrfCombos) {
  log(`V5 rrf ${JSON.stringify(w)}`);
  push(evaluate(`V5 RRF ${JSON.stringify(w)}`, (qi, K) => topKOf(fuseRrf(qi, w), K), [14, 20]));
}

// ── 报告 ──
const report = { queryCount: QUERIES.length, corpusFiles: N, results };
writeFileSync(
  new URL('./military-chain-ab.report.json', import.meta.url),
  JSON.stringify(report, null, 2),
);
console.log('Wrote evals/military-chain-ab.report.json');
log('done');
