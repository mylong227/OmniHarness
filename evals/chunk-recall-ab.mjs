#!/usr/bin/env node
// 「BM25 加切片（chunk）」离线 AB 裁定（**先验证空间，再决定要不要写生产代码**）。
//
// ## 动机与真正的机理（先把误会摆正）
//
// 常见的说法是「函数体与注释没进索引，所以召回差」。**这句话在本仓不成立**：
// `ContextEngine.indexCorpus` 的文件文档就是 `Bm25Index.tokenize(全文)` + 路径 token，
// 函数体与注释**早已在文件词袋里**。所以加 chunk 的收益**不是补内容**，而是
// **改变 BM25 长度归一化的粒度**：`b=0.75` 会把 500 行文件里出现 1 次的稀有词压得很平，
// 切成 80 行的块之后，同一稀有词在短文档里的 tf 权重显著上升 ⇒ 局部强信号不再被整文件稀释。
//
// ## 为什么必须先做本脚本（纪律）
//
// 本仓已有血案：层化图路由第 1 关（查询敏感度 0.038，比 BM25 还「查询专属」）**放行**，
// 第 2 关实测 **−9.1pp**。即「每次给不同的文件」与「每次给对的文件」是两回事。
// 故本脚本直接做**第 2 关**：同 corpus、同 fileK、开关隔离的召回对照 + 按查询 bootstrap。
//
// 用法：node evals/chunk-recall-ab.mjs [chunk 行数上限，默认 80]
// 产物：evals/chunk-recall-ab.report.json
// 免网络、免模型、免 API key。

import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { writeFileSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const DIST = join(ROOT, 'dist', 'src');
// Windows 下绝对路径必须是合法 file:// URL（直接 new URL('D:/...') 会抛 ERR_UNSUPPORTED_ESM_URL_SCHEME）。
const importDist = (...s) => import(pathToFileURL(join(DIST, ...s)).href);

const { ContextEngine } = await importDist('context', 'contextEngine.js');
const { Bm25Index } = await importDist('search', 'bm25Index.js');
const { RECALL_QUERIES } = await import(
  new URL('../dist/tests/fixtures/recallQueries.js', import.meta.url).href
);

const CHUNK_MAX_LINES = Number(process.argv[2] ?? 80);
const K = 20; // 与生产默认 fileK 一致
const RRF_K = 60;
const BOOT = 2000;

/** 固定种子 PRNG（门禁/评测里随机必须可复现）。 */
function mulberry32(seed) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const corpus = ContextEngine.indexCorpus(join(ROOT, 'src'), { morph: true, light: true });
console.log(`语料：${corpus.files.length} 文件 / ${corpus.symbols.length} 符号`);

// —— 建 chunk 索引：按符号行号切块（含前导注释 3 行），块长上限 CHUNK_MAX_LINES ——
const chunkDocs = [];
const chunkFile = [];
const chunkLens = [];
let truncatedByCap = 0;
const byFile = new Map();
for (let i = 0; i < corpus.symbols.length; i += 1) {
  const s = corpus.symbols[i];
  if (s === undefined) continue;
  if (!byFile.has(s.file)) byFile.set(s.file, []);
  byFile.get(s.file).push(i);
}
for (const [file, idxs] of byFile) {
  const text = corpus.fileText.get(file);
  if (text === undefined) continue;
  const lines = text.split('\n');
  const sorted = [...idxs].sort((a, b) => corpus.symbols[a].line - corpus.symbols[b].line);
  for (let j = 0; j < sorted.length; j += 1) {
    const s = corpus.symbols[sorted[j]];
    const start = Math.max(0, s.line - 1 - 3); // 含前导 JSDoc/注释 3 行
    const nextSym =
      sorted[j + 1] !== undefined ? corpus.symbols[sorted[j + 1]].line - 1 : lines.length;
    const end = Math.min(nextSym, s.line - 1 + CHUNK_MAX_LINES);
    const body = lines.slice(start, end).join('\n');
    chunkDocs.push([
      ...Bm25Index.tokenize(`${s.name} ${s.signature}\n${body}`),
      ...Bm25Index.tokenize(file),
    ]);
    chunkFile.push(file);
    chunkLens.push(end - start);
    if (end === s.line - 1 + CHUNK_MAX_LINES && end < nextSym) truncatedByCap += 1;
  }
}
const chunkIndex = new Bm25Index({ k1: 1.5, b: 0.75 });
chunkIndex.addDocuments(chunkDocs);
// 诚实披露块长：**实际块长由符号边界决定**，上限只在「下一个符号离得很远」（长函数体）时才生效。
// 实测 30 / 80 / 160 三档在 TS 语料上结果逐字相同，正是因为符号密集 ⇒ 上限几乎从不触发。
const avgLen = chunkDocs.length === 0 ? 0 : chunkLens.reduce((a, b) => a + b, 0) / chunkDocs.length;
console.log(
  `chunk 索引：${chunkDocs.length} 块｜平均 ${avgLen.toFixed(1)} 行｜被上限截断 ${truncatedByCap} 块（${((truncatedByCap / Math.max(1, chunkDocs.length)) * 100).toFixed(1)}%）｜上限 ${CHUNK_MAX_LINES} 行`,
);

function groundTruth(anchor) {
  const needle = anchor.toLowerCase();
  const set = new Set();
  for (const [rel, text] of corpus.fileText) {
    if (text.toLowerCase().includes(needle)) set.add(rel);
  }
  return set;
}

const rows = [];
for (const { q, anchor } of RECALL_QUERIES) {
  const gt = groundTruth(anchor);
  if (gt.size === 0) continue; // 锚点失效：跳过并记账（不静默吞、不崩溃）
  const base = ContextEngine.query(corpus, q, { fileK: K, rerank: true }).files;
  const baseHit = base.some((f) => gt.has(f)) ? 1 : 0;

  // chunk 路：取 top-200 块 → 按最高分聚合到文件 → 与基线 RRF 融合
  const hits = chunkIndex.search(Bm25Index.tokenizeExpanded(q), 200);
  const fileScore = new Map();
  for (const h of hits) {
    const f = chunkFile[h.id];
    if (f === undefined) continue;
    const prev = fileScore.get(f);
    if (prev === undefined || h.score > prev) fileScore.set(f, h.score);
  }
  const merged = new Map();
  base.forEach((f, i) => merged.set(f, (merged.get(f) ?? 0) + 1 / (RRF_K + i + 1)));
  [...fileScore.entries()]
    .sort((a, b) => b[1] - a[1])
    .forEach(([f], i) => merged.set(f, (merged.get(f) ?? 0) + 1 / (RRF_K + i + 1)));
  const fused = [...merged.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, K)
    .map(([f]) => f);
  const fusedHit = fused.some((f) => gt.has(f)) ? 1 : 0;

  rows.push({ q, anchor, baseHit, fusedHit, delta: fusedHit - baseHit });
}

const n = rows.length;
const rate = (key) => rows.filter((r) => r[key] === 1).length / n;
const baseRate = rate('baseHit');
const fusedRate = rate('fusedHit');
const diff = fusedRate - baseRate;

// 按查询配对 bootstrap（固定种子）
const rnd = mulberry32(20261002);
const deltas = [];
for (let b = 0; b < BOOT; b += 1) {
  let acc = 0;
  for (let i = 0; i < n; i += 1) acc += rows[Math.floor(rnd() * n)].delta;
  deltas.push(acc / n);
}
deltas.sort((a, b) => a - b);
const lo = deltas[Math.floor(0.025 * BOOT)];
const hi = deltas[Math.floor(0.975 * BOOT)];
const up = rows.filter((r) => r.delta > 0).length;
const down = rows.filter((r) => r.delta < 0).length;
const flat = n - up - down;

const pct = (r) => `${(r * 100).toFixed(1)}%`;
const pp = (r) => `${(r * 100).toFixed(1)}pp`;
console.log(
  `\n查询：${n} 条（语料 ${corpus.files.length} 文件），K=${K}，chunk 上限 ${CHUNK_MAX_LINES} 行`,
);
console.log('\n=== 命中率（hitRate@%d）===', K);
console.log(`  基线（生产默认，纯文件词袋 + 精排）  ${pct(baseRate)}`);
console.log(`  + chunk 切片路（RRF 融合，k=${RRF_K}）  ${pct(fusedRate)}`);
console.log(`  差值  ${pp(diff)}   95% CI [${pp(lo)}, ${pp(hi)}]`);
console.log(`\n=== 单查询分布（比均值诚实）===`);
console.log(`  提升 ${up} / 持平 ${flat} / 下降 ${down}`);
console.log(`\n=== 裁定（CI 跨 0 即判「与噪声不可区分」，即使点估计为正也不算增益）===`);
const crossesZero = lo < 0 && hi > 0;
const verdict = crossesZero
  ? `CI 跨 0 ⇒ 与噪声不可区分，**不落地生产代码**（点估计 ${pp(diff)} 不得写成增益）`
  : diff > 0
    ? `CI 下界 > 0 ⇒ 增益显著，可落地生产代码`
    : `CI 上界 < 0 ⇒ **净负面**，明确不落地（留档防重复投入）`;
console.log(`  ${verdict}`);

writeFileSync(
  new URL('./chunk-recall-ab.report.json', import.meta.url),
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      corpus: {
        files: corpus.files.length,
        symbols: corpus.symbols.length,
        chunks: chunkDocs.length,
      },
      config: { K, chunkMaxLines: CHUNK_MAX_LINES, rrfK: RRF_K, boot: BOOT, seed: 20261002 },
      base: +baseRate.toFixed(4),
      fused: +fusedRate.toFixed(4),
      diff: +diff.toFixed(4),
      ci95: [+lo.toFixed(4), +hi.toFixed(4)],
      distribution: { up, flat, down },
      verdict,
      rows,
    },
    null,
    2,
  ),
);
console.log('\nWrote evals/chunk-recall-ab.report.json');
