#!/usr/bin/env node
// 完整杀伤链组合实验（Chain AB）——检验五级能否**叠加**还是互相抵消。
//
//   第一段（雷达多频段 @1）：单字段 BM25 / 多字段归一化加权Σ / 多字段 RRF
//   第二段（高精度导弹 @3）：无 / 现有词法精排 / 字段增强精排（+路径覆盖信号）
//   预算  （近防炮 @5）：固定 fileK / 自适应 fileK（分数断崖截断）
//
// 判据：CI 下界 > 生产基线 69.7%（对抗口径 fileK=14 档）才算「翻默认级」证据。
//
// 用法：node evals/military-chain2-ab.mjs
// 输出：evals/military-chain2-ab.report.json

import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { writeFileSync, appendFileSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const DIST = join(ROOT, 'dist', 'src');
const importDist = (...segments) => import(pathToFileURL(join(DIST, ...segments)).href);

const PLOG = join(ROOT, 'military-chain2-progress.log');
writeFileSync(PLOG, `start ${new Date().toISOString()}\n`);
const log = (m) => appendFileSync(PLOG, m + '\n');

const { indexCorpus, query } = await importDist('context', 'contextEngine.js');
const { Bm25Index, tokenize, tokenizeExpanded } = await importDist('search', 'bm25Index.js');
const { outlineText } = await importDist('context', 'repoMap.js');
const { ContentStopWords } = await importDist('context', 'contentStopWords.js');
const { FileReranker } = await importDist('context', 'fileReranker.js');

const { QUERIES } = await import('./lib/query-set.mjs');

const SRC = join(ROOT, 'src');
const corpus = indexCorpus(SRC, { morph: true, light: true });
const rels = corpus.files.map((f) => f.rel);
const N = rels.length;
log(`corpus: ${N} files`);

function gtOf(anchor) {
  const needle = anchor.toLowerCase();
  const set = new Set();
  for (const [rel, text] of corpus.fileText) {
    if (text.toLowerCase().includes(needle)) set.add(rel);
  }
  return set;
}
const GTS = QUERIES.map(({ anchor }) => gtOf(anchor));
for (let i = 0; i < QUERIES.length; i++)
  if (GTS[i].size === 0) throw new Error(`GT=0 ${QUERIES[i].anchor}`);

// ── 字段索引 ──
const byFile = new Map();
for (const s of corpus.symbols) {
  const a = byFile.get(s.file);
  if (a === undefined) byFile.set(s.file, [s]);
  else a.push(s);
}
const FIELDS = ['content', 'path', 'symbols', 'signature'];
const docs = { content: [], path: [], symbols: [], signature: [] };
const nameSetByFile = new Map();
for (const rel of rels) {
  const text = corpus.fileText.get(rel) ?? '';
  docs.content.push(tokenize(text));
  docs.path.push(tokenizeExpanded(rel));
  const syms = byFile.get(rel) ?? [];
  const names = syms.flatMap((s) => tokenizeExpanded(s.name));
  docs.symbols.push(names);
  docs.signature.push(syms.flatMap((s) => tokenizeExpanded(s.signature)));
  nameSetByFile.set(rel, new Set(names));
}
const fieldIndex = {};
for (const f of FIELDS) {
  const ix = new Bm25Index();
  ix.addDocuments(docs[f]);
  fieldIndex[f] = ix;
}
function scoreVec(ix, qk) {
  const arr = new Float64Array(N);
  for (const h of ix.search(qk, N)) arr[h.id] = h.score;
  return arr;
}
function maxNorm(v) {
  let m = 0;
  for (const x of v) if (x > m) m = x;
  if (m === 0) return v;
  const o = new Float64Array(v.length);
  for (let i = 0; i < v.length; i++) o[i] = v[i] / m;
  return o;
}
const qkOf = QUERIES.map(({ q }) => tokenizeExpanded(q));
const raw = {};
for (const f of FIELDS) raw[f] = qkOf.map((qk) => scoreVec(fieldIndex[f], qk));

function fuseSum(qi, w) {
  const v = new Float64Array(N);
  for (const f of FIELDS) {
    const wf = w[f] ?? 0;
    if (wf === 0) continue;
    const nv = maxNorm(raw[f][qi]);
    for (let i = 0; i < N; i++) v[i] += wf * nv[i];
  }
  return v;
}
function fuseRrf(qi, w, k = 60) {
  const v = new Float64Array(N);
  for (const f of FIELDS) {
    const wf = w[f] ?? 0;
    if (wf === 0) continue;
    const vec = raw[f][qi];
    const order = [...vec.keys()].filter((i) => vec[i] > 0).sort((a, b) => vec[b] - vec[a]);
    for (let r = 0; r < order.length; r++) v[order[r]] += wf / (k + r + 1);
  }
  return v;
}
function order(v) {
  return [...v.keys()]
    .filter((i) => v[i] > 0)
    .sort((a, b) => v[b] - v[a])
    .map((i) => rels[i]);
}

/** 字段增强精排：倒数秩 + 符号名覆盖 + 路径覆盖 + 内容覆盖（信号权重可配置）。 */
function enhancedRerank(qi, candidates, K, sig) {
  const terms = qkOf[qi].filter((t) => ContentStopWords.isContent(t));
  const uniq = [...new Set(terms)];
  const wOf = (t) => {
    const v = corpus.fileIndex.idf(t);
    return v > 0 ? v : 0.05;
  };
  const total = uniq.reduce((a, t) => a + wOf(t), 0) || 1;
  const scored = candidates.map((rel, i) => {
    const rankTerm = 1 / (1 + (i + 1));
    const names = nameSetByFile.get(rel) ?? new Set();
    let nameCov = 0;
    for (const t of uniq) if (names.has(t)) nameCov += wOf(t);
    nameCov /= total;
    const pathLower = rel.toLowerCase();
    let pathCov = 0;
    for (const t of uniq) if (pathLower.includes(t)) pathCov += wOf(t);
    pathCov /= total;
    const text = (corpus.fileText.get(rel) ?? '').toLowerCase();
    let contentCov = 0;
    for (const t of uniq) if (text.includes(t)) contentCov += wOf(t);
    contentCov /= total;
    return {
      rel,
      rank: i + 1,
      nameCov,
      pathCov,
      contentCov,
      score:
        (sig.rank ?? 0) * rankTerm +
        (sig.name ?? 0) * nameCov +
        (sig.path ?? 0) * pathCov +
        (sig.content ?? 0) * contentCov,
    };
  });
  scored.sort((a, b) => b.score - a.score || a.rank - b.rank);
  return scored;
}

const reranker = new FileReranker();

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
  return {
    mean: +(values.reduce((a, b) => a + b, 0) / n).toFixed(4),
    lo: +means[Math.floor(B * 0.025)].toFixed(4),
    hi: +means[Math.floor(B * 0.975)].toFixed(4),
  };
}

const KS = [10, 14, 20];
const results = [];

/** rankFn(qi,K) → files。 */
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
      for (let i = 0; i < files.length; i++)
        if (gt.has(files[i])) {
          rank = i + 1;
          break;
        }
      mrrs.push(rank > 0 ? 1 / rank : 0);
      const fs = new Set(files);
      toks.push(tokenize(outlineText(corpus.symbols.filter((s) => fs.has(s.file)))).length + 160);
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
  const r = { name, perK };
  results.push(r);
  for (const K of Ks) {
    const p = r.perK[K];
    console.log(
      `${name.padEnd(36)} K=${String(K).padStart(2)}  命中率=${(p.hitRate.mean * 100).toFixed(1)}%` +
        `[${(p.hitRate.lo * 100).toFixed(1)},${(p.hitRate.hi * 100).toFixed(1)}]  P=${(p.precision.mean * 100).toFixed(1)}%  ` +
        `recall=${(p.recall.mean * 100).toFixed(1)}%  MRR=${p.mrr.mean.toFixed(3)}  tok=${p.tokens}`,
    );
  }
  console.log('');
  return r;
}

// 生产基线
log('C0');
evaluate('C0 生产默认(单字段+重排)', (qi, K) => [
  ...query(corpus, QUERIES[qi].q, { fileK: K, rerank: true }).files,
]);

// 第一段候选池深度对齐生产（37），保证可比
const POOL = 37;
const multiW = { content: 1, symbols: 4, signature: 4 };
const rrfW = { content: 1, path: 1, symbols: 1, signature: 1 };
const sumCands = (qi) => order(fuseSum(qi, multiW)).slice(0, POOL);
const rrfCands = (qi) => order(fuseRrf(qi, rrfW)).slice(0, POOL);
const hybridCands = (qi) => {
  const a = maxNorm(fuseSum(qi, multiW));
  const b = maxNorm(fuseRrf(qi, rrfW));
  const v = new Float64Array(N);
  for (let i = 0; i < N; i++) v[i] = a[i] + b[i];
  return order(v).slice(0, POOL);
};
const applyRerank = (qi, cands, K) => [
  ...reranker.rerank({ corpus, query: QUERIES[qi].q, candidates: cands, fileK: K }).files,
];
const applyEnhanced = (qi, cands, K, sig) =>
  enhancedRerank(qi, cands, K, sig)
    .slice(0, K)
    .map((s) => s.rel);

log('C1');
evaluate('C1 多字段Σ 无重排', (qi, K) => sumCands(qi).slice(0, K));
log('C2');
evaluate('C2 多字段Σ + 现有重排', (qi, K) => applyRerank(qi, sumCands(qi), K));
log('C3');
evaluate('C3 RRF 无重排', (qi, K) => rrfCands(qi).slice(0, K));
log('C4');
evaluate('C4 RRF + 现有重排', (qi, K) => applyRerank(qi, rrfCands(qi), K));
log('C5');
evaluate('C5 RRF + 增强(秩+符号名)', (qi, K) =>
  applyEnhanced(qi, rrfCands(qi), K, { rank: 1, name: 1 }),
);
log('C6');
evaluate('C6 RRF + 增强(+内容覆盖)', (qi, K) =>
  applyEnhanced(qi, rrfCands(qi), K, { rank: 1, name: 1.5, content: 0.5 }),
);
log('C7');
evaluate('C7 RRF + 增强(+路径覆盖)', (qi, K) =>
  applyEnhanced(qi, rrfCands(qi), K, { rank: 1, name: 1, path: 1 }),
);
log('C8');
evaluate('C8 Σ+RRF混合 + 现有重排', (qi, K) => applyRerank(qi, hybridCands(qi), K));
log('C9');
evaluate('C9 Σ+RRF混合 + 增强(秩+名+内容)', (qi, K) =>
  applyEnhanced(qi, hybridCands(qi), K, { rank: 1, name: 1.5, content: 0.5 }),
);

// 汇总中位数对比
console.log('=== K=14 汇总 ===');
const base = results[0].perK[14];
for (const r of results) {
  const p = r.perK[14];
  const d = ((p.hitRate.mean - base.hitRate.mean) * 100).toFixed(1);
  console.log(
    `${r.name.padEnd(36)} 命中率=${(p.hitRate.mean * 100).toFixed(1)}%  差基线=${d}pp  ` +
      `CI下界=${(p.hitRate.lo * 100).toFixed(1)}%  MRR=${p.mrr.mean.toFixed(3)}  tok=${p.tokens}  未命中=${p.fails.length}`,
  );
}

writeFileSync(
  new URL('./military-chain2-ab.report.json', import.meta.url),
  JSON.stringify({ queryCount: QUERIES.length, results }, null, 2),
);
console.log('Wrote evals/military-chain2-ab.report.json');
log('done');
