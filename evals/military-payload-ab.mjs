#!/usr/bin/env node
// 弹药投送实验（Payload AB）——「高精度导弹」的另一半：
// 命中哪些文件由【排序】决定；注入多少字由【呈现形式】决定。两者可解耦。
//
// 现状（T0）：把 fileK 个文件的**完整符号大纲**全量注入，其中第 4..14 个文件
// 命中概率已很低，它们的符号表是纯弹药浪费。
//
// 变体：
//   T0 现状（全大纲 + 固定 30 符号行）
//   T1 分层投送：Top-M 给完整大纲，其余仅给「📄 路径」一行（M 扫描）
//   T2 符号裁剪：只列**名字命中查询内容词**的符号行（保留线索、去掉无关行）
//   T3 T1+T2 组合
//
// 判据：**文件集合不变 ⇒ 命中率逐字不变**；本实验只度量 token 降幅。
// 诚实边界：命中率是「文件集合」口径；上下文变薄对**下游完成率**的影响需 P6 端到端基准验证。
//
// 用法：node evals/military-payload-ab.mjs
// 输出：evals/military-payload-ab.report.json

import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { writeFileSync, appendFileSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const DIST = join(ROOT, 'dist', 'src');
const importDist = (...segments) => import(pathToFileURL(join(DIST, ...segments)).href);

const PLOG = join(ROOT, 'military-payload-progress.log');
writeFileSync(PLOG, `start ${new Date().toISOString()}\n`);
const log = (m) => appendFileSync(PLOG, m + '\n');

const { ContextEngine } = await importDist('context', 'contextEngine.js');
const { Bm25Index } = await importDist('search', 'bm25Index.js');
const { RepoMap } = await importDist('context', 'repoMap.js');
const { ContentStopWords } = await importDist('context', 'contentStopWords.js');

const { QUERIES } = await import('./lib/query-set.mjs');

const SRC = join(ROOT, 'src');
const corpus = ContextEngine.indexCorpus(SRC, { morph: true, light: true });
log(`corpus: ${corpus.files.length} files, ${corpus.symbols.length} symbols`);

const symsByFile = new Map();
for (const s of corpus.symbols) {
  const arr = symsByFile.get(s.file);
  if (arr === undefined) symsByFile.set(s.file, [s]);
  else arr.push(s);
}

function gtOf(anchor) {
  const needle = anchor.toLowerCase();
  const set = new Set();
  for (const [rel, text] of corpus.fileText) {
    if (text.toLowerCase().includes(needle)) set.add(rel);
  }
  return set;
}
const GTS = QUERIES.map(({ anchor }) => gtOf(anchor));
for (let i = 0; i < QUERIES.length; i++) {
  if (GTS[i].size === 0) throw new Error(`GT=0: ${QUERIES[i].anchor}`);
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
  return {
    mean: +(values.reduce((a, b) => a + b, 0) / n).toFixed(4),
    lo: +means[Math.floor(B * 0.025)].toFixed(4),
    hi: +means[Math.floor(B * 0.975)].toFixed(4),
  };
}

/** 组装一份上下文，返回 {text, tokens}。params 控制呈现形式。 */
function assemble(files, syms, opts = {}) {
  const { headM = Infinity, namesOnly = false, terms = null, dropSigLines = false } = opts;
  const head = files.slice(0, headM);
  const tail = files.slice(headM);
  const parts = ['# Repo Map (relevant files)'];
  if (head.length > 0)
    parts.push(RepoMap.outlineText(head.flatMap((f) => symsByFile.get(f) ?? [])));
  for (const f of tail) parts.push(`📄 ${f}`);
  parts.push('# Relevant Symbols');
  if (!dropSigLines) {
    const keep =
      namesOnly && terms !== null ? syms.filter((s) => terms.has(s.name.toLowerCase())) : syms;
    for (const s of keep) parts.push(`L${s.line} ${s.kind} ${s.name} @ ${s.file}`);
  }
  const text = parts.join('\n');
  return { text, tokens: Bm25Index.tokenize(text).length };
}

const KS = [10, 14];
const HEAD_MS = [1, 2, 3, 5, 8];
const report = { queryCount: QUERIES.length, variants: [] };

/** 每个查询先算一次生产结果（文件集合与符号行），供所有呈现变体共用。 */
const perQuery = [];
for (const { q } of QUERIES) {
  const r = ContextEngine.query(corpus, q, { fileK: 20, rerank: true });
  const terms = new Set(Bm25Index.tokenizeExpanded(q).filter((t) => ContentStopWords.isContent(t)));
  perQuery.push({ q, files: [...r.files], syms: [...r.symbols], terms });
  if (perQuery.length % 10 === 0) log(`prepared ${perQuery.length}`);
}
log('per-query prepared');

function measure(name, optsFor) {
  const perK = {};
  for (const K of KS) {
    const toks = [];
    const hits = [];
    const toksNoSig = [];
    for (let i = 0; i < QUERIES.length; i++) {
      const { files, syms, terms } = perQuery[i];
      const top = files.slice(0, K);
      const full = assemble(top, syms, { terms });
      const vari = assemble(top, syms, { ...optsFor(K, terms), terms });
      toks.push(vari.tokens);
      toksNoSig.push(vari.tokens);
      hits.push(top.some((f) => GTS[i].has(f)) ? 1 : 0);
      if (K === KS[0] && i === 0) log(`  sample: ${name} K=${K} tok=${vari.tokens}`);
    }
    perK[K] = {
      tokens: Math.round(toks.reduce((a, b) => a + b, 0) / toks.length),
      hitRate: ci(hits),
    };
  }
  const row = { name, perK };
  report.variants.push(row);
  for (const K of KS) {
    console.log(
      `${name.padEnd(30)} K=${String(K).padStart(2)}  token=${String(row.perK[K].tokens).padStart(5)}  ` +
        `命中率=${(row.perK[K].hitRate.mean * 100).toFixed(1)}%`,
    );
  }
  console.log('');
  return row;
}

// T0 现状：全大纲 + 30 符号行
const t0 = measure('T0 现状(全大纲)', () => ({}));

// T1 分层：Top-M 全大纲，其余仅路径
for (const M of HEAD_MS) {
  measure(`T1 分层 Top-${M} 全大纲`, () => ({ headM: M }));
}

// T2 符号行裁剪：只保留名字命中查询内容词的符号行
measure('T2 符号行裁剪', () => ({ namesOnly: true }));

// T3 组合
for (const M of HEAD_MS) {
  measure(`T3 组合 Top-${M} + 裁剪`, () => ({ headM: M, namesOnly: true }));
}

// 汇总：相对 T0 的 token 降幅
console.log('=== 相对 T0 的 token 降幅（K=14） ===');
const base = t0.perK[14].tokens;
for (const v of report.variants) {
  const t = v.perK[14].tokens;
  console.log(
    `${v.name.padEnd(30)} token=${String(t).padStart(5)}  降幅=${(((base - t) / base) * 100).toFixed(1)}%  命中率=${(v.perK[14].hitRate.mean * 100).toFixed(1)}%`,
  );
}

writeFileSync(
  new URL('./military-payload-ab.report.json', import.meta.url),
  JSON.stringify(report, null, 2),
);
console.log('Wrote evals/military-payload-ab.report.json');
log('done');
