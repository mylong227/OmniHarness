#!/usr/bin/env node
// 检索评测查询集的**协议校验 + 难度画像**（评测侧门禁，免网络免模型）。
//
// 为什么单列一个脚本：锚点是否真实存在（GT 非空）需要索引语料，属慢检查，不适合放进单测；
// 但若锚点写错，评测会把「锚点不存在」误读成「检索失败」——这正是本仓反复治的「假信号」。
// 故：**任一锚点 GT 为空即中止（exit 1）**，并打印逐条难度分布，便于人工判断新条目是否退化。
//
// 用法：node evals/recall-query-audit.mjs
// 产物：evals/recall-query-audit.report.json

import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { writeFileSync } from 'node:fs';
import { CORE_COUNT, RECALL_QUERIES } from '../dist/tests/fixtures/recallQueries.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const DIST = join(ROOT, 'dist', 'src');
const importDist = (...segments) => import(pathToFileURL(join(DIST, ...segments)).href);

const { ContextEngine } = await importDist('context', 'contextEngine.js');
const { Bm25Index } = await importDist('search', 'bm25Index.js');

const K = 20; // 生产默认注入预算
const RANK_CAP = 200; // 超出即判为词法盲区（与 headroom-analysis 同口径）

const corpus = ContextEngine.indexCorpus(join(ROOT, 'src'), { morph: true, light: true });
console.log(`语料：${corpus.files.length} 文件 / ${corpus.symbols.length} 符号`);
console.log(`查询：${RECALL_QUERIES.length} 条（其中冻结子集 ${CORE_COUNT} 条）\n`);

/** 锚点字面量所在文件集合（GT）。 */
function groundTruth(anchor) {
  const needle = anchor.toLowerCase();
  const set = new Set();
  for (const [rel, text] of corpus.fileText) {
    if (text.toLowerCase().includes(needle)) set.add(rel);
  }
  return set;
}

const rows = [];
let missing = 0;
for (const { q, anchor } of RECALL_QUERIES) {
  const gt = groundTruth(anchor);
  if (gt.size === 0) {
    missing += 1;
    console.error(`✗ 锚点不存在（GT=0）：anchor="${anchor}" query="${q}"`);
  }
  // 深层候选池里的最佳排位（全语料），用于难度分类
  const tokens = Bm25Index.tokenizeExpanded(q);
  const deep = corpus.fileIndex.search(tokens, corpus.files.length);
  let bestRank = Number.POSITIVE_INFINITY;
  for (let i = 0; i < deep.length; i += 1) {
    const hit = deep[i];
    if (hit === undefined) continue;
    const rel = corpus.files[hit.id]?.rel;
    if (rel !== undefined && gt.has(rel)) {
      bestRank = i + 1;
      break;
    }
  }
  const top = ContextEngine.query(corpus, q, { fileK: K, rerank: true }).files;
  const hit = top.some((f) => gt.has(f));
  const band = hit
    ? 'OK'
    : Number.isFinite(bestRank) && bestRank <= RANK_CAP
      ? 'RANKING'
      : 'LEXICAL';
  rows.push({
    q,
    anchor,
    gtSize: gt.size,
    bestRank: Number.isFinite(bestRank) ? bestRank : null,
    hitAtK: hit ? 1 : 0,
    band,
  });
}

if (missing > 0) {
  console.error(`\n❌ 有 ${missing} 条锚点的 GT 为空：评测集不可用（修正锚点或从集合中移除）。`);
  process.exit(1);
}

const n = rows.length;
const count = (pred) => rows.filter(pred).length;
const rate = (pred) => +((count(pred) / n) * 100).toFixed(1);
const bandCounts = {
  OK: count((r) => r.band === 'OK'),
  RANKING: count((r) => r.band === 'RANKING'),
  LEXICAL: count((r) => r.band === 'LEXICAL'),
};
const core = rows.slice(0, CORE_COUNT);
const ext = rows.slice(CORE_COUNT);
const hitRateOf = (list) =>
  +((list.filter((r) => r.hitAtK === 1).length / Math.max(1, list.length)) * 100).toFixed(1);

console.log('=== 难度画像（hitRate@%d + 深层最佳排位）===', K);
console.log(
  `  全量 %d 条：命中 %s%`,
  n,
  rate((r) => r.hitAtK === 1),
);
console.log(
  `    OK %d / RANKING %d / LEXICAL %d`,
  bandCounts.OK,
  bandCounts.RANKING,
  bandCounts.LEXICAL,
);
console.log(`  冻结子集 %d 条：命中 %s%`, core.length, hitRateOf(core));
console.log(`  新增子集 %d 条：命中 %s%`, ext.length, hitRateOf(ext));
const rankBands = [
  ['≤20', (r) => r.bestRank !== null && r.bestRank <= 20],
  ['21–50', (r) => r.bestRank !== null && r.bestRank > 20 && r.bestRank <= 50],
  ['51–200', (r) => r.bestRank !== null && r.bestRank > 50 && r.bestRank <= 200],
  ['>200 或缺失', (r) => r.bestRank === null || r.bestRank > 200],
];
console.log('\n  深层最佳排位分布：');
for (const [label, pred] of rankBands) {
  console.log(`    ${label.padEnd(12)} ${count(pred)} 条`);
}

writeFileSync(
  new URL('./recall-query-audit.report.json', import.meta.url),
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      corpus: { files: corpus.files.length, symbols: corpus.symbols.length },
      config: { K, RANK_CAP },
      total: n,
      coreCount: CORE_COUNT,
      hitRate: {
        all: rate((r) => r.hitAtK === 1),
        core: hitRateOf(core),
        extended: hitRateOf(ext),
      },
      bands: bandCounts,
      rows,
    },
    null,
    2,
  ),
);
console.log('\nWrote evals/recall-query-audit.report.json');
