#!/usr/bin/env node
// Pareto 前沿实验（命中率 × token 成本）。
//
// 核心问题：用户要「保精度 + 提命中 + 降 token」三者兼得 —— 是否可能？
// 关键洞察：**命中哪些文件靠排序，注入多少字靠呈现**，两者可解耦。
//   模式 A（现状）：fileK 个文件的完整符号大纲全量注入。
//   模式 B（分层）：Top-M 给完整大纲，其余仅给「📄 路径」一行。
//   模式 C（分层+裁剪）：在 B 之上，符号行只保留名字命中查询词的。
//
// 于是「省下的 token」可反向兑换为「更多文件覆盖」：同 token 下覆盖 30 个文件 vs 14 个。
//
// 用法：node evals/military-pareto.mjs
// 输出：evals/military-pareto.report.json

import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { writeFileSync, appendFileSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const DIST = join(ROOT, 'dist', 'src');
const importDist = (...segments) => import(pathToFileURL(join(DIST, ...segments)).href);

const PLOG = join(ROOT, 'military-pareto-progress.log');
writeFileSync(PLOG, `start ${new Date().toISOString()}\n`);
const log = (m) => appendFileSync(PLOG, m + '\n');

const { ContextEngine } = await importDist('context', 'contextEngine.js');
const { Bm25Index } = await importDist('search', 'bm25Index.js');
const { RepoMap } = await importDist('context', 'repoMap.js');
const { ContentStopWords } = await importDist('context', 'contentStopWords.js');
const { QUERIES } = await import('./lib/query-set.mjs');

const SRC = join(ROOT, 'src');
const corpus = ContextEngine.indexCorpus(SRC, { morph: true, light: true });
log(`corpus: ${corpus.files.length} files`);

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

/** 组装：mode A=全大纲；B=Top-M 大纲+其余路径；C=B+符号行裁剪。 */
function assemble(files, syms, mode, M, terms) {
  const parts = ['# Repo Map (relevant files)'];
  const headN = mode === 'A' ? files.length : M;
  const head = files.slice(0, headN);
  const tail = files.slice(headN);
  if (head.length) parts.push(RepoMap.outlineText(head.flatMap((f) => symsByFile.get(f) ?? [])));
  for (const f of tail) parts.push(`📄 ${f}`);
  parts.push('# Relevant Symbols');
  const keep = mode === 'C' ? syms.filter((s) => terms.has(s.name.toLowerCase())) : syms;
  for (const s of keep) parts.push(`L${s.line} ${s.kind} ${s.name} @ ${s.file}`);
  const text = parts.join('\n');
  return Bm25Index.tokenize(text).length;
}

const KS = [3, 4, 5, 6, 8, 10, 12, 14, 16, 20, 24, 30, 40];
const modes = [
  { name: 'A 现状(全大纲)', mode: 'A', M: Infinity },
  { name: 'B 分层 Top-3', mode: 'B', M: 3 },
  { name: 'B 分层 Top-5', mode: 'B', M: 5 },
  { name: 'C 分层Top-3+裁剪', mode: 'C', M: 3 },
  { name: 'C 分层Top-5+裁剪', mode: 'C', M: 5 },
];

// 预算扫描上限：query 的候选池 ≈ 37，故 fileK 超过池深无意义
const perQuery = [];
for (const { q } of QUERIES) {
  const r = ContextEngine.query(corpus, q, { fileK: 40, rerank: true });
  const terms = new Set(Bm25Index.tokenizeExpanded(q).filter((t) => ContentStopWords.isContent(t)));
  perQuery.push({ q, files: [...r.files], syms: [...r.symbols], terms });
}
log('prepared');

const report = { queryCount: QUERIES.length, poolDepth: perQuery[0].files.length, curves: [] };
for (const md of modes) {
  const curve = [];
  for (const K of KS) {
    const toks = [];
    const hits = [];
    for (let i = 0; i < QUERIES.length; i++) {
      const { files, syms, terms } = perQuery[i];
      const top = files.slice(0, K);
      toks.push(assemble(top, syms, md.mode, md.M, terms));
      hits.push(top.some((f) => GTS[i].has(f)) ? 1 : 0);
    }
    curve.push({
      K,
      tokens: Math.round(toks.reduce((a, b) => a + b, 0) / toks.length),
      hitRate: ci(hits),
    });
  }
  report.curves.push({ name: md.name, curve });
  console.log(`\n=== ${md.name} ===`);
  for (const p of curve) {
    console.log(
      `  fileK=${String(p.K).padStart(2)}  token=${String(p.tokens).padStart(5)}  ` +
        `命中率=${(p.hitRate.mean * 100).toFixed(1)}% [${(p.hitRate.lo * 100).toFixed(1)},${(p.hitRate.hi * 100).toFixed(1)}]`,
    );
  }
}

// 等 token 对照：给定 token 预算，各模式能达到的最高命中率
console.log('\n=== 等 token 预算下的最优命中率（线性插值） ===');
function bestAt(curve, budget) {
  const pts = curve.filter((p) => p.tokens <= budget).sort((a, b) => b.tokens - a.tokens);
  return pts.length ? pts[0] : null;
}
for (const budget of [800, 1200, 1600, 2200, 3000, 3800]) {
  let line = `  token≤${String(budget).padStart(4)}  `;
  for (const c of report.curves) {
    const b = bestAt(c.curve, budget);
    line += `${c.name.split(' ')[0]}${c.name.includes('Top-') ? c.name.split(' ')[1] : ''}=${b ? (b.hitRate.mean * 100).toFixed(1) + '%' : '--'}  `;
  }
  console.log(line);
}

writeFileSync(
  new URL('./military-pareto.report.json', import.meta.url),
  JSON.stringify(report, null, 2),
);
console.log('\nWrote evals/military-pareto.report.json');
log('done');
