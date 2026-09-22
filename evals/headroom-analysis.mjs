#!/usr/bin/env node
// 检索「优化空间」诊断：回答「命中率还能不能再提升、还剩多少空间」。
//
// 不做空谈——把 33 条查询的**失败原因**拆开量化：
//   ① 对每条查询取「深层候选池」（fileK=DEEP，覆盖全语料）的完整 BM25 排序，
//      定位 GT 文件的最佳排位 bestRank。
//   ② 失败分类（这是空间估算的根）：
//        · OK            bestRank <= K            —— 已命中，无需提升
//        · RANKING       K < bestRank <= RANK_CAP  —— GT 在候选池里但没排进 Top-K
//                                                     ⇒ **排序手段可救**（rerank / 分数融合 / 结构信号）
//        · LEXICAL      bestRank > RANK_CAP 或不存在 —— GT 与查询词表几乎无交集
//                                                     ⇒ **词法盲区**，只有语义路 / 查询扩展可救
//   ③ 上界分析：在候选深度 D 下「完美重排」能达到的 oracle 命中率
//      = 当前命中率与理论天花板之间的真实差距。
//   ④ 实测现有 opt-in 手段（PRF / rerank / 两者叠加）各自吃掉多少空间。
//
// 诚实纪律：所有数字来自真实 src/ 语料 + 真实生产 query()；不编分数、不报无 CI 的点估计当作结论。
//
// 用法（免网络、免模型）：
//   node evals/headroom-analysis.mjs
// 输出：evals/headroom-analysis.report.json + 控制台摘要。

import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { writeFileSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const DIST = join(ROOT, 'dist', 'src');
const importDist = (...segments) => import(pathToFileURL(join(DIST, ...segments)).href);
import { RECALL_QUERIES, CORE_COUNT } from '../dist/tests/fixtures/recallQueries.js';

const { indexCorpus, query } = await importDist('context', 'contextEngine.js');

const SRC = join(ROOT, 'src');
const K = 10; // 生产默认预算（P5 降档档=5）
const DEEP = 600; // 深层候选池（>语料文件数，等价于全排序）
const RANK_CAP = 200; // 「排序可救」的深度上限（超出即判为词法盲区）

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

// 与 evals/recall-precision.mjs 同源的 33 条查询（锚点定位答案，避免自证循环）。
const QUERIES = RECALL_QUERIES;
const CORE_SUBSET = CORE_COUNT;

for (const { q, anchor } of QUERIES) {
  if (groundTruth(anchor).size === 0) {
    throw new Error(`锚点不存在（GT=0）：query="${q}" anchor="${anchor}"`);
  }
}

/** 取某配置下的 Top-K 文件（有序）。 */
function topFiles(q, k, opts = {}) {
  return query(corpus, q, { fileK: k, rerank: false, prf: false, ...opts }).files;
}

/** GT 文件在深层候选池中的最佳排位（1-based）；未出现则为 Infinity。 */
function bestRankInDeepPool(q, gt) {
  const pool = topFiles(q, DEEP);
  for (let i = 0; i < pool.length; i++) {
    if (gt.has(pool[i])) return i + 1;
  }
  return Number.POSITIVE_INFINITY;
}

// —— 逐查询诊断 ——
const rows = [];
for (const { q, anchor } of QUERIES) {
  const gt = groundTruth(anchor);
  const deepRank = bestRankInDeepPool(q, gt);
  const base = topFiles(q, K);
  const hitsBase = base.filter((f) => gt.has(f)).length;
  const prf = topFiles(q, K, { prf: true });
  const hitsPrf = prf.filter((f) => gt.has(f)).length;
  const rr = topFiles(q, K, { rerank: true });
  const hitsRr = rr.filter((f) => gt.has(f)).length;
  const both = topFiles(q, K, { rerank: true, prf: true });
  const hitsBoth = both.filter((f) => gt.has(f)).length;

  let failure;
  if (hitsBase > 0) failure = 'OK';
  else if (deepRank <= RANK_CAP) failure = 'RANKING';
  else failure = 'LEXICAL';

  rows.push({
    q,
    anchor,
    gtSize: gt.size,
    deepRank: Number.isFinite(deepRank) ? deepRank : null,
    hitBase: hitsBase > 0 ? 1 : 0,
    hitPrf: hitsPrf > 0 ? 1 : 0,
    hitRerank: hitsRr > 0 ? 1 : 0,
    hitBoth: hitsBoth > 0 ? 1 : 0,
    failure,
  });
}

const n = rows.length;
const count = (pred) => rows.filter(pred).length;
const rate = (pred) => +((count(pred) / n) * 100).toFixed(1);

// —— 失败模式分布 ——
const byFailure = {
  OK: count((r) => r.failure === 'OK'),
  RANKING: count((r) => r.failure === 'RANKING'),
  LEXICAL: count((r) => r.failure === 'LEXICAL'),
};

// —— 现有手段实测 ——
const variants = {
  'BM25(基线)': rate((r) => r.hitBase === 1),
  'BM25+PRF': rate((r) => r.hitPrf === 1),
  'BM25+rerank': rate((r) => r.hitRerank === 1),
  'BM25+PRF+rerank': rate((r) => r.hitBoth === 1),
};

// —— 上界：候选深度 D 下的「完美重排」oracle 命中率 ——
// 若 GT 的最佳排位 <= D，则存在一个完美重排器能把它排进 Top-K（只要 K>=1）。
const oracleByDepth = {};
for (const D of [10, 20, 50, 100, 200, 400, DEEP]) {
  oracleByDepth[D] = rate((r) => r.deepRank !== null && r.deepRank <= D);
}

// —— 空间拆解 ——
const current = variants['BM25(基线)'];
const oracleAll = oracleByDepth[DEEP]; // 全语料完美重排的理论天花板
const rankingRecoverable = byFailure.RANKING; // 排序手段可救的条数
const lexicalOnly = byFailure.LEXICAL;

console.log('\n=== 失败模式分布（K=10） ===');
console.log(`  已命中 OK        : ${byFailure.OK}/${n}  (${rate((r) => r.failure === 'OK')}%)`);
console.log(
  `  排序可救 RANKING  : ${byFailure.RANKING}/${n}  (${rate((r) => r.failure === 'RANKING')}%)  ← GT 在候选池但没排进 Top-${K}`,
);
console.log(
  `  词法盲区 LEXICAL  : ${byFailure.LEXICAL}/${n}  (${rate((r) => r.failure === 'LEXICAL')}%)  ← GT 与查询词表几乎无交集`,
);

console.log('\n=== 现有手段实测命中率（K=10） ===');
for (const [name, v] of Object.entries(variants)) {
  const delta =
    name === 'BM25(基线)'
      ? ''
      : `  (${(v - current >= 0 ? '+' : '') + (v - current).toFixed(1)}pp)`;
  console.log(`  ${name.padEnd(18)} ${v}%${delta}`);
}

console.log('\n=== 完美重排上界（oracle，按候选深度） ===');
for (const [D, v] of Object.entries(oracleByDepth)) {
  console.log(`  候选深度 D=${String(D).padStart(3)}  ⇒ oracle 命中率 ${v}%`);
}

console.log('\n=== 空间拆解 ===');
console.log(`  当前命中率                     ${current}%`);
console.log(`  可达天花板（受词法盲区限制）     ${oracleAll}%   ← 排序/融合手段的理论上限`);
console.log(
  `   ⇒ 排序/融合可吃空间            ${(oracleAll - current).toFixed(1)}pp  (${rankingRecoverable} 条)`,
);
console.log(
  `   ⇒ 须语义路才能突破             ${((lexicalOnly / n) * 100).toFixed(1)}pp  (${lexicalOnly} 条，GT 与查询零词法交集)`,
);
console.log(
  `  （两者相加 ${(oracleAll - current + (lexicalOnly / n) * 100).toFixed(1)}pp = 到 100% 的总空间）`,
);
console.log(
  `\n  注：实测「扩大候选池」对上述两类均无效（evals/pool-depth-probe.mjs：池 37.6→202.7 命中率不变），`,
);
console.log(
  `      真正的杠杆是检索预算 fileK × rerank 组合，见 evals/budget-recall-tradeoff.mjs。`,
);

const totalToPerfect = +(100 - current).toFixed(1);

const report = {
  generatedAt: new Date().toISOString(),
  corpus: { files: corpus.files.length, symbols: corpus.symbols.length },
  config: { K, DEEP, RANK_CAP },
  queryCount: n,
  failureModes: byFailure,
  variants,
  oracleByDepth,
  headroom: {
    current,
    /** 受词法盲区限制的可达天花板（排序/融合手段的理论上限）。 */
    reachableCeiling: oracleAll,
    /** 排序/融合手段可争取空间 = reachableCeiling − current。 */
    rankingRecoverablePp: +(oracleAll - current).toFixed(1),
    /** 须语义路才能突破的空间 = 100 − reachableCeiling。 */
    lexicalOnlyPp: +((lexicalOnly / n) * 100).toFixed(1),
    /** 到 100% 的总空间（两者之和）。 */
    totalToPerfectPp: totalToPerfect,
    counts: { ok: byFailure.OK, ranking: rankingRecoverable, lexical: lexicalOnly },
  },
  rows,
};

writeFileSync(
  new URL('./headroom-analysis.report.json', import.meta.url),
  JSON.stringify(report, null, 2),
);
console.log('\nWrote evals/headroom-analysis.report.json');
