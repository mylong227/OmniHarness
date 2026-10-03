#!/usr/bin/env node
/**
 * 检索命中率探针（G21 提升入库，2026-10-03；**离线、免网络、免模型、确定性**）。
 *
 * ## 回答什么问题
 *
 * 「生产口径（`fileK` + 可选精排）下，冻结查询集的 hitRate@K 是多少，95% CI 有多宽」——
 * 这是本仓所有检索改动的**基线量**；没有它就分不清"改动有效"与"查询集噪声"。
 *
 * ## 口径（与 `tests/unit/retrievalBaseline.test.ts` 同源，但这里给的是**数字**而非门禁）
 *
 * - 语料：仓库 `src/`（`morph` 开、`light` 档，与生产默认一致）；
 * - 查询：`tests/fixtures/recallQueries.ts`（冻结 `core` 段 + 扩样 `ext` 段）；
 * - GT：由「文件正文包含锚点字面量」**机械推出**，不依赖 BM25 ⇒ 无自证循环；
 * - 统计：hitRate + **配对 bootstrap 95% CI**（2000 次重采样，固定种子 ⇒ 可复现）。
 *
 * ## 前置
 *
 * 需要编译产物：先 `npm run build`（本探针 import `dist/src/**` 与 `dist/tests/fixtures/**`）。
 *
 * ## 用法
 *
 * ```bash
 * node tools/probes/recallHitrate.mjs                       # fileK=20，不精排
 * node tools/probes/recallHitrate.mjs --rerank              # 开精排（生产路径同款）
 * node tools/probes/recallHitrate.mjs --fileK=14 --json=out.json
 * ```
 *
 * ## 诚实边界
 *
 * - 只测**文件级命中**（GT 文件是否进 Top-K），不测符号级精确率；
 * - `core` 段是冻结集（跨版本可比），`ext` 段是扩样集（可比性弱于 core）；
 * - 数字随语料变化而变（`src/` 每加文件都会影响召回）⇒ **跨提交比较必须同语料**。
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
/** 仓库根（本文件在 `tools/probes/` 下，故上溯两级）。 */
const ROOT = join(HERE, '..', '..');
const importDist = (...segments) =>
  import(pathToFileURL(join(ROOT, 'dist', 'src', ...segments)).href);

/**
 * 读命令行 `--name=value`。
 * @param {string} name 参数名（不含 `--`）。
 * @param {string} dflt 缺省值。
 * @returns {string} 值。
 */
function arg(name, dflt) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit === undefined ? dflt : hit.slice(name.length + 3);
}

let RECALL_QUERIES;
let CORE_COUNT;
let ContextEngine;
try {
  ({ RECALL_QUERIES, CORE_COUNT } = await import(
    pathToFileURL(join(ROOT, 'dist', 'tests', 'fixtures', 'recallQueries.js')).href
  ));
  ({ ContextEngine } = await importDist('context', 'contextEngine.js'));
} catch (error) {
  console.error(
    '✗ 缺少编译产物。请先运行 `npm run build`（本探针需要 dist/src/** 与 dist/tests/fixtures/**）。\n' +
      `  原因：${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(2);
}

const FILE_K = Number(arg('fileK', '20'));
const RERANK = process.argv.includes('--rerank');
const JSON_OUT = arg('json', '');

const corpus = ContextEngine.indexCorpus(join(ROOT, 'src'), { morph: true, light: true });

/**
 * 机械推出 GT：文件正文含锚点字面量即真值（大小写不敏感）。
 * @param {string} anchor 锚点串。
 * @returns {Set<string>} GT 文件集合。
 */
function groundTruth(anchor) {
  const needle = anchor.toLowerCase();
  const set = new Set();
  for (const [rel, text] of corpus.fileText) {
    if (text.toLowerCase().includes(needle)) set.add(rel);
  }
  return set;
}

const rows = [];
for (let i = 0; i < RECALL_QUERIES.length; i += 1) {
  const { q, anchor } = RECALL_QUERIES[i];
  const gt = groundTruth(anchor);
  if (gt.size === 0) throw new Error(`锚点不存在（GT=0）：query="${q}" anchor="${anchor}"`);
  const result = ContextEngine.query(corpus, q, { fileK: FILE_K, rerank: RERANK });
  const ranked = result.ranked ?? result.files ?? [];
  const top = ranked.slice(0, FILE_K);
  rows.push({
    i,
    core: i < CORE_COUNT,
    q,
    hit: top.some((rel) => gt.has(rel)) ? 1 : 0,
    bestRank: ranked.findIndex((rel) => gt.has(rel)) + 1 || -1,
  });
}

/**
 * 命中率。
 * @param {readonly {hit: number}[]} subset 子集。
 * @returns {number} 命中率。
 */
function rate(subset) {
  return subset.length === 0 ? 0 : subset.reduce((s, r) => s + r.hit, 0) / subset.length;
}

/**
 * 配对 bootstrap 95% CI（固定种子，确定性可复现）。
 * @param {readonly {hit: number}[]} subset 子集。
 * @param {number} seed 随机种子。
 * @returns {[number, number]} CI 下界与上界。
 */
function bootstrapCI(subset, seed = 12345) {
  if (subset.length === 0) return [0, 0];
  let state = seed >>> 0;
  const rnd = () => (state = (state * 1664525 + 1013904223) >>> 0) / 0x100000000;
  const means = [];
  for (let b = 0; b < 2000; b += 1) {
    let sum = 0;
    for (let k = 0; k < subset.length; k += 1) sum += subset[Math.floor(rnd() * subset.length)].hit;
    means.push(sum / subset.length);
  }
  means.sort((a, b) => a - b);
  return [means[Math.floor(0.025 * means.length)], means[Math.floor(0.975 * means.length)]];
}

const core = rows.filter((r) => r.core);
const ext = rows.filter((r) => !r.core);
const report = {
  probe: 'recallHitrate',
  fileK: FILE_K,
  rerank: RERANK,
  corpus: { files: corpus.files.length, symbols: corpus.symbols.length },
  all: { n: rows.length, hitRate: rate(rows), ci95: bootstrapCI(rows) },
  core: { n: core.length, hitRate: rate(core), ci95: bootstrapCI(core) },
  ext: { n: ext.length, hitRate: rate(ext), ci95: bootstrapCI(ext) },
  misses: rows
    .filter((r) => r.hit === 0)
    .map((r) => ({ i: r.i, core: r.core, q: r.q, bestRank: r.bestRank })),
};
const pct = (x) => `${(x * 100).toFixed(1)}%`;
console.log(
  `fileK=${FILE_K} rerank=${RERANK} 语料 ${corpus.files.length} 文件 / ${corpus.symbols.length} 符号\n` +
    `  all  n=${report.all.n}  hitRate=${pct(report.all.hitRate)} CI[${pct(report.all.ci95[0])}, ${pct(report.all.ci95[1])}]\n` +
    `  core n=${report.core.n}  hitRate=${pct(report.core.hitRate)} CI[${pct(report.core.ci95[0])}, ${pct(report.core.ci95[1])}]\n` +
    `  ext  n=${report.ext.n}  hitRate=${pct(report.ext.hitRate)} CI[${pct(report.ext.ci95[0])}, ${pct(report.ext.ci95[1])}]`,
);
for (const m of report.misses) {
  console.log(`  MISS ${m.core ? 'core' : 'ext '} #${m.i} bestRank=${m.bestRank} :: ${m.q}`);
}
if (JSON_OUT !== '') {
  writeFileSync(JSON_OUT, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`\n已写出 ${JSON_OUT}`);
}
