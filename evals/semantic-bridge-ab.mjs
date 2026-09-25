#!/usr/bin/env node
// 语义路的两条改进假说，在**与生产同等的第二段精排**基础上做受控对照。
//
// 为什么必须带精排做对照：生产默认档 = 第一段 BM25 → 第二段零依赖词法精排（`FileReranker`）。
// 若变体在「无精排」的弱基线上比，就会把**精排本就有的增益**误记成语义路的功劳
// （实测：无精排基线 66.7% vs 带精排 75.8%——差 9.1pp，全部来自精排）。故本脚本的基线
// 与全部变体都经同一 `FileReranker`，口径与生产一致。
//
// 假说 A —— **语义→词法桥接（SLB）**：从语义 Top-N 命中收割标识符（符号名 + 路径），回灌 BM25 再搜。
//   动机：既有 PRF/RM3 从**词法 Top-3** 收割扩展词，而 BM25 恰在需要的查询上失败 ⇒ 收割源本身是错的。
//   换成语义 Top-N 作收割源，正是「意思对、字面不同」那类查询的解药。
// 假说 B —— **预算感知并集**：梯度投送下尾部文件只花一行 `📄 路径`（约 10 token），
//   故在同一 token 预算内可以多买覆盖：BM25 精排 Top-K ∪ 语义发现（廉价路径行）。
//
// 用法：OMNI_HF_ENDPOINT=https://hf-mirror.com node evals/semantic-bridge-ab.mjs [preset]
// 输出：evals/semantic-bridge-ab.report.json + 控制台摘要。

import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { writeFileSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const DIST = join(ROOT, 'dist', 'src');
const importDist = (...s) => import(pathToFileURL(join(DIST, ...s)).href);

const { ContextEngine } = await importDist('context', 'contextEngine.js');
const { SemanticIndexCache } = await importDist('context', 'semanticIndexCache.js');
const { SemanticIndex } = await importDist('context', 'semanticIndex.js');
const { RecallKnobs } = await importDist('context', 'recallKnobs.js');
const { FileReranker } = await importDist('context', 'fileReranker.js');
const { RepoMapPayload } = await importDist('context', 'repoMapPayload.js');
const { Bm25Index } = await importDist('search', 'bm25Index.js');
const { TransformersEmbeddingAdapter } = await importDist(
  'adapters',
  'embedding',
  'transformersEmbeddingAdapter.js',
);
const { QUERIES } = await import('./lib/query-set.mjs');
const { CachedEmbeddingPort } = await import('./lib/embedding-cache.mjs');

const SRC = join(ROOT, 'src');
const PRESET = process.argv[2] ?? 'e5-small-v2';
const FILE_K = 20;
const SYM_K = 24;
const CACHE_DIR = process.env.OMNI_EMBEDDING_CACHE_DIR ?? 'D:/deepseek/.omni-model-cache';
const VEC_CACHE = process.env.OMNI_VEC_CACHE ?? 'D:/deepseek/.omni-vec-cache';

const corpus = ContextEngine.indexCorpus(SRC, { morph: true, light: true });
console.log(`语料：${corpus.files.length} 文件 / ${corpus.symbols.length} 符号`);

const embedding = new CachedEmbeddingPort(
  new TransformersEmbeddingAdapter({
    preset: PRESET,
    cacheDir: CACHE_DIR,
    remoteHost: process.env.OMNI_HF_ENDPOINT ?? process.env.HF_ENDPOINT,
    localFilesOnly: process.env.OMNI_EMBEDDING_OFFLINE === '1',
  }),
  join(VEC_CACHE, `${PRESET}-${FILE_K}`),
);
console.log(`模型：${embedding.inner.modelId}（${embedding.dim} 维）`);

const reranker = new FileReranker();

/** ground truth：含锚点子串的文件集合。 */
function groundTruth(anchor) {
  const needle = anchor.toLowerCase();
  const set = new Set();
  for (const [rel, text] of corpus.fileText) {
    if (text.toLowerCase().includes(needle)) set.add(rel);
  }
  return set;
}
const gts = new Map();
for (const { q, anchor } of QUERIES) {
  const gt = groundTruth(anchor);
  if (gt.size === 0) throw new Error(`锚点不存在：${anchor}`);
  gts.set(q, gt);
}

/** 配对 bootstrap（对逐条差值重采样）。 */
function pairedBootstrap(diffs, B = 4000) {
  const n = diffs.length;
  const mean = diffs.reduce((a, b) => a + b, 0) / n;
  let seed = 0x9e3779b9;
  const rnd = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 0xffffffff;
  };
  const means = [];
  for (let b = 0; b < B; b++) {
    let s = 0;
    for (let i = 0; i < n; i++) s += diffs[Math.floor(rnd() * n)];
    means.push(s / n);
  }
  means.sort((a, b) => a - b);
  return {
    mean: +(mean * 100).toFixed(1),
    lo: +(means[Math.floor(B * 0.025)] * 100).toFixed(1),
    hi: +(means[Math.floor(B * 0.975)] * 100).toFixed(1),
  };
}

const t0 = Date.now();
const semIdx = await new SemanticIndexCache().get(SRC, corpus, embedding, new RecallKnobs({}));
console.log(`语义索引就绪：${((Date.now() - t0) / 1000).toFixed(1)}s`);

/**
 * 第一段：**忠实复刻生产** `contextEngine.query` 的候选池构造。
 *
 * 生产候选池不是「BM25 文件路 top-20」，而是
 * `fileScore = max(文件BM25分, 0.7 × 该文件最强符号分)` —— 即「文件路 ∪ 符号路映射回的文件」。
 * 踩坑留档：本脚本初版只取文件路 top-20 当候选，于是重排器只有 20 个候选可动，
 * 基线算出 66.7%，而生产入口实测是 75.8%——差的 9.1pp 全是**候选池深度**，不是任何新算法。
 * 复刻错口径会让所有变体的 Δ 虚高（并集变体一度显出虚假的「+12.1pp 显著正」）。
 * 第一段函数必须与 `contextEngine.query` 同构造。
 * @param tokens 已分词的查询词。
 * @returns 按 fileScore 降序的 rel 列表（**不截断**，与生产一致）。
 */
function firstStageTokens(tokens) {
  const fileHits = [...corpus.fileIndex.search(tokens, FILE_K)];
  const symHits = [...corpus.symbolIndex.search(tokens, 60)];
  const bestSym = new Map();
  for (const h of symHits) {
    const s = corpus.symbols[h.id];
    if (s === undefined) continue;
    const cur = bestSym.get(s.file) ?? 0;
    if (h.score > cur) bestSym.set(s.file, h.score);
  }
  const score = new Map();
  for (const h of fileHits) {
    const f = corpus.files[h.id];
    if (f === undefined) continue;
    score.set(f.rel, Math.max(h.score, 0.7 * (bestSym.get(f.rel) ?? 0)));
  }
  for (const [file, s] of bestSym) {
    if (!score.has(file)) score.set(file, 0.7 * s);
  }
  return [...score.entries()].sort((a, b) => b[1] - a[1]).map(([rel]) => rel);
}
/** 第二段：生产同款零依赖词法精排。 */
function secondStage(candidates, q, k = FILE_K) {
  return reranker.rerank({ corpus, query: q, candidates, fileK: k }).files;
}
/** 取 BM25 符号路命中的符号（供 token 如实估算，与生产一致）。 */
function bm25Syms(queryTokens) {
  return [...corpus.symbolIndex.search(queryTokens, SYM_K)]
    .map((h) => corpus.symbols[h.id])
    .filter((s) => s !== undefined);
}
const lex = (q) => (corpus.morph ? Bm25Index.tokenizeExpanded(q) : Bm25Index.tokenize(q));

/** 从语义命中收割标识符词（只取语料内已存在的词，避免引入语料外噪声）。 */
function harvest(hits, topN, useSym, usePath) {
  const terms = [];
  const seen = new Set();
  for (const h of hits.slice(0, topN)) {
    const n = Number(h.id.slice(h.id.indexOf(':') + 1));
    if (!Number.isFinite(n)) continue;
    const pieces = [];
    if (h.id.startsWith('sym:') && useSym) {
      const sym = corpus.symbols[n];
      if (sym !== undefined)
        pieces.push(...Bm25Index.tokenize(sym.name), ...Bm25Index.tokenize(sym.file));
    } else if (h.id.startsWith('file:') && usePath) {
      pieces.push(...Bm25Index.tokenize(h.id.slice(5)));
    }
    for (const p of pieces) {
      if (p.length >= 3 && !seen.has(p)) {
        seen.add(p);
        terms.push(p);
      }
    }
  }
  return terms;
}

/** 估注入 token：走生产同一 `RepoMapPayload` 梯度档（符号取 BM25 符号路，与生产一致）。 */
function payloadTokens(rels, q) {
  return Bm25Index.tokenize(
    RepoMapPayload.assemble(
      { corpus, files: rels, symbols: bm25Syms(lex(q)), query: q },
      RepoMapPayload.DEFAULT_PLAN,
    ),
  ).length;
}

const scenarios = [
  { label: '基线：BM25 → 精排（= 生产默认档）', kind: 'base' },
  { label: 'RRF(BM25, 语义) → 精排（现混合口径）', kind: 'rrf' },
  { label: 'SLB top5（收割符号名+路径）', kind: 'bridge', topN: 5, sym: true, path: true },
  { label: 'SLB top10（收割符号名+路径）', kind: 'bridge', topN: 10, sym: true, path: true },
  { label: 'SLB top20（收割符号名+路径）', kind: 'bridge', topN: 20, sym: true, path: true },
  { label: 'SLB top10（只收割符号名）', kind: 'bridge', topN: 10, sym: true, path: false },
  { label: '并集 K=30（精排20 ∪ 语义10）', kind: 'union', extra: 10 },
  { label: '并集 K=40（精排20 ∪ 语义20）', kind: 'union', extra: 20 },
  { label: '并集 K=60（精排20 ∪ 语义40）', kind: 'union', extra: 40 },
  { label: '并集 SLB∪：精排(SLB10) ∪ 语义20', kind: 'unionBridge', extra: 20, topN: 10 },
];

const semCache = new Map();
const results = [];
let baseline = null;

for (const sc of scenarios) {
  const hits = [];
  const toks = [];
  const detail = [];
  for (const { q } of QUERIES) {
    const gt = gts.get(q);
    let sem = semCache.get(q);
    if (sem === undefined) {
      sem = await semIdx.search(q, 40);
      semCache.set(q, sem);
    }
    const semFiles = sem.filter((h) => h.id.startsWith('file:')).map((h) => h.id.slice(5));
    let rels;
    if (sc.kind === 'base') {
      rels = secondStage(firstStageTokens(lex(q)), q);
    } else if (sc.kind === 'rrf') {
      const base = firstStageTokens(lex(q));
      const merged = SemanticIndex.rrfMerge(
        [base.map((id) => ({ id })), semFiles.map((id) => ({ id }))],
        60,
        [1, 1],
      ).map((id) => id.replace(/^file:/, ''));
      rels = secondStage(merged, q);
    } else if (sc.kind === 'bridge' || sc.kind === 'unionBridge') {
      const extra = harvest(sem, sc.topN, sc.sym, sc.path);
      const cand = firstStageTokens([...lex(q), ...extra]);
      rels = secondStage(cand, q);
      if (sc.kind === 'unionBridge') {
        const seen = new Set(rels);
        for (const f of semFiles) {
          if (!seen.has(f)) {
            seen.add(f);
            rels.push(f);
          }
        }
        rels = rels.slice(0, FILE_K + sc.extra);
      }
    } else {
      rels = secondStage(firstStageTokens(lex(q)), q);
      const seen = new Set(rels);
      for (const f of semFiles) {
        if (!seen.has(f)) {
          seen.add(f);
          rels.push(f);
        }
      }
      rels = rels.slice(0, FILE_K + sc.extra);
    }
    const hit = rels.some((f) => gt.has(f)) ? 1 : 0;
    hits.push(hit);
    toks.push(payloadTokens(rels, q));
    detail.push({ q, hit, head: rels.slice(0, 4) });
  }
  if (baseline === null) baseline = hits;
  const diffs = hits.map((h, i) => h - baseline[i]);
  const ci = pairedBootstrap(diffs);
  const mean = +((hits.reduce((a, b) => a + b, 0) / hits.length) * 100).toFixed(1);
  const avgTok = Math.round(toks.reduce((a, b) => a + b, 0) / toks.length);
  const moved = diffs.reduce((a, b) => a + Math.abs(b), 0) / 2;
  const flag = ci.lo > 0 ? '✅ 显著正' : ci.hi < 0 ? '❌ 显著负' : '·  不显著';
  console.log(
    `  ${sc.label.padEnd(38)} ${String(mean).padStart(5)}%  Δ=${String(ci.mean).padStart(5)}pp ` +
      `[${ci.lo}, ${ci.hi}]  ${flag}  变动 ${moved}/33  ${avgTok} tok`,
  );
  results.push({
    label: sc.label,
    hitRate: mean,
    delta: ci.mean,
    ci: [ci.lo, ci.hi],
    changed: moved,
    avgTokens: avgTok,
    detail,
  });
}

// —— 天花板诊断 ——
const semRank = QUERIES.map(({ q }, i) => {
  const sem = semCache.get(q);
  const gt = gts.get(q);
  const r = sem.findIndex((h) => h.id.startsWith('file:') && gt.has(h.id.slice(5)));
  return r < 0 ? null : r + 1;
});
const missed = QUERIES.map((x, i) => i).filter((i) => baseline[i] === 0);
const reachable = missed.filter((i) => semRank[i] !== null);
console.log(`\n=== 天花板诊断 ===`);
console.log(
  `  基线（BM25→精排）漏 ${missed.length}/33；语义 Top-40 能排到目标的仅 ${reachable.length} 条`,
);
for (const i of missed) {
  console.log(
    `    [${semRank[i] === null ? '语义也未命中' : `语义 rank=${semRank[i]}`}] ${QUERIES[i].q}`,
  );
}

const report = {
  generatedAt: new Date().toISOString(),
  hypotheses: ['semantic-to-lexical bridging', 'budget-aware union'],
  model: {
    preset: PRESET,
    id: embedding.inner.modelId,
    dim: embedding.dim,
    remoteHost: embedding.inner.remoteHostUsed ?? null,
  },
  corpus: { files: corpus.files.length, symbols: corpus.symbols.length },
  config: {
    fileK: FILE_K,
    symK: SYM_K,
    queryCount: QUERIES.length,
    pipeline: 'BM25 → FileReranker（与生产同口径）',
  },
  results,
  ceiling: { baselineMissed: missed.length, semanticallyReachable: reachable.length, semRank },
};
writeFileSync(
  new URL('./semantic-bridge-ab.report.json', import.meta.url),
  JSON.stringify(report, null, 2),
);
console.log('\nWrote evals/semantic-bridge-ab.report.json');
