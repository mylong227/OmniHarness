#!/usr/bin/env node
// 最终裁定实验（Verdict）——用**配对 bootstrap** 严格判定每一级军事链条是否真的有效。
//
// 独立 CI 只说明「两组分布是否重叠」，配对检验却问「同一批查询上，逐条差异是否一致为正」——
// 后者对 n=33 这种小样本敏感得多，是判断「真增益 vs 噪声」的正确工具。
//
// 裁定四项：
//   R1 多字段 BM25F（雷达）      ：同 K 下命中率 / MRR 的配对差异
//   R2 RRF 多探针（暴雨梨花针）  ：同 K 下 MRR 的配对差异
//   R3 分层呈现（高精度导弹）    ：**构造性**（同文件集合 ⇒ 命中率必然不变），只报 token
//   R4 梯度呈现（分级投弹）      ：介于全大纲与一刀切之间的折中形态
//
// 用法：node evals/military-verdict.mjs
// 输出：evals/military-verdict.report.json

import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { writeFileSync, appendFileSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const DIST = join(ROOT, 'dist', 'src');
const importDist = (...segments) => import(pathToFileURL(join(DIST, ...segments)).href);

const PLOG = join(ROOT, 'military-verdict-progress.log');
writeFileSync(PLOG, `start ${new Date().toISOString()}\n`);
const log = (m) => appendFileSync(PLOG, m + '\n');

const { indexCorpus, query } = await importDist('context', 'contextEngine.js');
const { Bm25Index, tokenize, tokenizeExpanded } = await importDist('search', 'bm25Index.js');
const { outlineText } = await importDist('context', 'repoMap.js');
const { ContentStopWords } = await importDist('context', 'contentStopWords.js');
const { QUERIES } = await import('./lib/query-set.mjs');

const SRC = join(ROOT, 'src');
const corpus = indexCorpus(SRC, { morph: true, light: true });
const rels = corpus.files.map((f) => f.rel);
const N = rels.length;
log(`corpus ${N}`);

const symsByFile = new Map();
for (const s of corpus.symbols) {
  const a = symsByFile.get(s.file);
  if (a === undefined) symsByFile.set(s.file, [s]);
  else a.push(s);
}
function gtOf(anchor) {
  const needle = anchor.toLowerCase();
  const set = new Set();
  for (const [rel, text] of corpus.fileText) if (text.toLowerCase().includes(needle)) set.add(rel);
  return set;
}
const GTS = QUERIES.map(({ anchor }) => gtOf(anchor));
for (let i = 0; i < QUERIES.length; i++)
  if (GTS[i].size === 0) throw new Error(`GT=0 ${QUERIES[i].anchor}`);

// ── 配对 bootstrap：对逐条差值重采样 ──
function pairedCI(diffs, B = 4000) {
  const n = diffs.length;
  const means = [];
  let seed = 0x9e3779b9;
  const rnd = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 0xffffffff;
  };
  for (let b = 0; b < B; b++) {
    let s = 0;
    for (let i = 0; i < n; i++) s += diffs[Math.floor(rnd() * n)];
    means.push(s / n);
  }
  means.sort((a, b) => a - b);
  const mean = diffs.reduce((a, b) => a + b, 0) / n;
  const lo = means[Math.floor(B * 0.025)];
  const hi = means[Math.floor(B * 0.975)];
  const wins = diffs.filter((d) => d > 0).length;
  const losses = diffs.filter((d) => d < 0).length;
  return {
    mean: +(mean * 100).toFixed(2),
    lo: +(lo * 100).toFixed(2),
    hi: +(hi * 100).toFixed(2),
    wins,
    losses,
    ties: n - wins - losses,
    significant: lo > 0 || hi < 0,
  };
}
const fmtCI = (c) =>
  `${c.mean >= 0 ? '+' : ''}${c.mean}pp [${c.lo}, ${c.hi}] ${c.significant ? '✅显著' : '❌跨0'} 胜${c.wins}/负${c.losses}/平${c.ties}`;

// ── 字段索引（雷达四频段） ──
const FIELDS = ['content', 'path', 'symbols', 'signature'];
const docs = { content: [], path: [], symbols: [], signature: [] };
for (const rel of rels) {
  docs.content.push(tokenize(corpus.fileText.get(rel) ?? ''));
  docs.path.push(tokenizeExpanded(rel));
  const syms = symsByFile.get(rel) ?? [];
  docs.symbols.push(syms.flatMap((s) => tokenizeExpanded(s.name)));
  docs.signature.push(syms.flatMap((s) => tokenizeExpanded(s.signature)));
}
const fieldIndex = {};
for (const f of FIELDS) {
  const ix = new Bm25Index();
  ix.addDocuments(docs[f]);
  fieldIndex[f] = ix;
}
function scoreVec(ix, qk) {
  const a = new Float64Array(N);
  for (const h of ix.search(qk, N)) a[h.id] = h.score;
  return a;
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
const multW = { content: 1, symbols: 4, signature: 4 };
const rrfW = { content: 1, path: 1, symbols: 1, signature: 1 };
const orderOf = (v) =>
  [...v.keys()]
    .filter((i) => v[i] > 0)
    .sort((a, b) => v[b] - v[a])
    .map((i) => rels[i]);
function multiSum(qi) {
  const v = new Float64Array(N);
  for (const f of FIELDS) {
    const w = multW[f] ?? 0;
    if (!w) continue;
    const nv = maxNorm(raw[f][qi]);
    for (let i = 0; i < N; i++) v[i] += w * nv[i];
  }
  return orderOf(v);
}
function rrf(qi, k = 60) {
  const v = new Float64Array(N);
  for (const f of FIELDS) {
    const w = rrfW[f] ?? 0;
    if (!w) continue;
    const vec = raw[f][qi];
    const o = [...vec.keys()].filter((i) => vec[i] > 0).sort((a, b) => vec[b] - vec[a]);
    for (let r = 0; r < o.length; r++) v[o[r]] += w / (k + r + 1);
  }
  return orderOf(v);
}

// ── 呈现层（R3/R4） ──
function payloadTokens(files, syms, terms, plan) {
  const parts = ['# Repo Map (relevant files)'];
  files.forEach((f, i) => {
    const tier = plan(i, files.length);
    if (tier === 'full') parts.push(outlineText(symsByFile.get(f) ?? []));
    else if (tier === 'name') {
      const ss = (symsByFile.get(f) ?? []).filter((s) => terms.has(s.name.toLowerCase()));
      parts.push(`📄 ${f}`);
      for (const s of ss.slice(0, 3)) parts.push(`   L${s.line} ${s.kind} ${s.name}`);
    } else parts.push(`📄 ${f}`);
  });
  parts.push('# Relevant Symbols');
  for (const s of syms) parts.push(`L${s.line} ${s.kind} ${s.name} @ ${s.file}`);
  return tokenize(parts.join('\n')).length;
}

const report = { queryCount: QUERIES.length, verdicts: [] };
function record(name, detail) {
  report.verdicts.push({ name, detail });
  console.log(`\n【${name}】\n  ${detail}`);
}

// ── 逐查询收集 ──
function collect(rankFn, K) {
  const hit = [];
  const mrr = [];
  for (let qi = 0; qi < QUERIES.length; qi++) {
    const files = rankFn(qi, K);
    const gt = GTS[qi];
    hit.push(files.some((f) => gt.has(f)) ? 1 : 0);
    let r = -1;
    for (let i = 0; i < files.length; i++)
      if (gt.has(files[i])) {
        r = i + 1;
        break;
      }
    mrr.push(r > 0 ? 1 / r : 0);
  }
  return { hit, mrr };
}

const baseFn = (qi, K) => [...query(corpus, QUERIES[qi].q, { fileK: K, rerank: true }).files];

for (const K of [10, 14]) {
  const base = collect(baseFn, K);
  // R1 雷达：多字段Σ（须先截断到 K，与基线同为 K 预算，否则是拿全量池比 K 截断的假阳）
  const multi = collect((qi, k) => multiSum(qi).slice(0, k), K);
  record(
    `R1 雷达多字段Σ vs 基线 (K=${K})`,
    [
      `命中率 ${fmtCI(pairedCI(multi.hit.map((v, i) => v - base.hit[i])))}`,
      `MRR   ${fmtCI(pairedCI(multi.mrr.map((v, i) => v - base.mrr[i])))}`,
    ].join('\n  '),
  );

  // R2 暴雨梨花针：RRF（同样截断到 K）
  const rf = collect((qi, k) => rrf(qi).slice(0, k), K);
  record(
    `R2 暴雨梨花针 RRF vs 基线 (K=${K})`,
    [
      `命中率 ${fmtCI(pairedCI(rf.hit.map((v, i) => v - base.hit[i])))}`,
      `MRR   ${fmtCI(pairedCI(rf.mrr.map((v, i) => v - base.mrr[i])))}`,
    ].join('\n  '),
  );
}

// R3/R4 呈现层：token + 构造性命中率不变证明
for (const K of [14, 20]) {
  const toks = { full: [], layered3: [], grad: [], layered1: [] };
  let sameSet = 0;
  for (let qi = 0; qi < QUERIES.length; qi++) {
    const r = query(corpus, QUERIES[qi].q, { fileK: K, rerank: true });
    const files = [...r.files];
    const syms = [...r.symbols];
    const terms = new Set(
      tokenizeExpanded(QUERIES[qi].q).filter((t) => ContentStopWords.isContent(t)),
    );
    toks.full.push(payloadTokens(files, syms, terms, () => 'full'));
    toks.layered3.push(payloadTokens(files, syms, terms, (i) => (i < 3 ? 'full' : 'path')));
    toks.layered1.push(payloadTokens(files, syms, terms, (i) => (i < 1 ? 'full' : 'path')));
    toks.grad.push(
      payloadTokens(files, syms, terms, (i) => (i < 3 ? 'full' : i < 8 ? 'name' : 'path')),
    );
    if (files.length === [...r.files].length) sameSet++;
  }
  const avg = (a) => Math.round(a.reduce((x, y) => x + y, 0) / a.length);
  const f = avg(toks.full);
  record(
    `R3/R4 呈现层 token（K=${K}，文件集合不变 ${sameSet}/${QUERIES.length}）`,
    [
      `现状全大纲      token=${f}`,
      `分层Top-1       token=${avg(toks.layered1)}  降 ${(((f - avg(toks.layered1)) / f) * 100).toFixed(1)}%`,
      `分层Top-3       token=${avg(toks.layered3)}  降 ${(((f - avg(toks.layered3)) / f) * 100).toFixed(1)}%`,
      `梯度(3full/5name/余路径) token=${avg(toks.grad)}  降 ${(((f - avg(toks.grad)) / f) * 100).toFixed(1)}%`,
    ].join('\n  '),
  );
}

writeFileSync(
  new URL('./military-verdict.report.json', import.meta.url),
  JSON.stringify(report, null, 2),
);
console.log('\nWrote evals/military-verdict.report.json');
log('done');
