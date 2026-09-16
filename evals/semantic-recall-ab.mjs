#!/usr/bin/env node
// 语义嵌入路 A/B：真实 ONNX 模型（经镜像下载）对 33 条对抗锚点查询的召回增益实测。
//
// 背景：语义路（`getHybridRepoMapContext`）此前**只在评测脚本里可用**——脚本自行设 `env.remoteHost`，
// 而生产装配路径（`configFactory`）无对应旋钮 ⇒ 在无法直连 huggingface.co 的网络里必然不可达。
// 本轮补齐了 `remoteHost` 旋钮（`OMNI_HF_ENDPOINT` / `HF_ENDPOINT`），故本实验**走生产入口**：
//   基线 = `engine.getRepoMapContext(root, q)`（当前生产默认档，纯 BM25 + 精排 + K=20 + 梯度投送）
//   实验 = `engine.getHybridRepoMapContext(root, q, embedding, opts)`（BM25 ∪ 语义，RRF 融合）
// 两者都从返回文本解析 `📄 路径` 行得到**文件秩**，与实际注入给模型的集合完全一致。
//
// 用法：
//   OMNI_HF_ENDPOINT=https://hf-mirror.com node evals/semantic-recall-ab.mjs [preset]
// 输出：evals/semantic-recall-ab.report.json + 控制台摘要。

import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { writeFileSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const DIST = join(ROOT, 'dist', 'src');
const importDist = (...s) => import(pathToFileURL(join(DIST, ...s)).href);

const { indexCorpus } = await importDist('context', 'contextEngine.js');
const { RepoMapContextEngine } = await importDist('context', 'repoMapContextEngine.js');
const { TransformersEmbeddingAdapter } = await importDist(
  'adapters',
  'embedding',
  'transformersEmbeddingAdapter.js',
);
const { tokenize } = await importDist('search', 'bm25Index.js');
const { CachedEmbeddingPort } = await import('./lib/embedding-cache.mjs');
const { QUERIES } = await import('./lib/query-set.mjs');

const SRC = join(ROOT, 'src');
const PRESET = process.argv[2] ?? 'e5-small-v2';
const FILE_K = 20;
const SYM_K = 24;
const CACHE_DIR = process.env.OMNI_EMBEDDING_CACHE_DIR ?? 'D:/deepseek/.omni-model-cache';
const VEC_CACHE = process.env.OMNI_VEC_CACHE ?? 'D:/deepseek/.omni-vec-cache';

console.log(`=== 语义召回 A/B ===`);
console.log(`preset=${PRESET}  fileK=${FILE_K}  symK=${SYM_K}  cacheDir=${CACHE_DIR}`);
console.log(`HF endpoint=${process.env.OMNI_HF_ENDPOINT ?? process.env.HF_ENDPOINT ?? '(未设)'}`);

const corpus = indexCorpus(SRC, { morph: true, light: true });
console.log(`语料：${corpus.files.length} 文件 / ${corpus.symbols.length} 符号`);

const engine = new RepoMapContextEngine();

const embedding = new CachedEmbeddingPort(
  new TransformersEmbeddingAdapter({
    preset: PRESET,
    cacheDir: CACHE_DIR,
    remoteHost: process.env.OMNI_HF_ENDPOINT ?? process.env.HF_ENDPOINT,
    localFilesOnly: process.env.OMNI_EMBEDDING_OFFLINE === '1',
  }),
  join(VEC_CACHE, `${PRESET}-${FILE_K}`),
);
console.log(`模型：${embedding.inner.modelId}（${embedding.dim} 维）向量缓存：${VEC_CACHE}`);

/** 从生产产出文本解析文件秩（`📄 路径` 行的出现顺序即排名）。 */
function filesOf(text) {
  if (text === null) return [];
  return text
    .split('\n')
    .filter((l) => l.startsWith('📄 '))
    .map((l) => l.replace(/^📄\s*/, '').trim());
}

/** 无偏 ground truth：含锚点子串的文件集合（不依赖任何检索器，避免自证）。 */
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
  if (gt.size === 0) throw new Error(`锚点不存在（GT=0）：anchor="${anchor}"`);
  gts.set(q, gt);
}

/** 配对 bootstrap：对逐条差值重采样（n=33 小样本下比独立 CI 更敏感）。 */
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

const scenarios = [
  { label: '基线（纯 BM25 + 精排 + K=20 + 梯度）', hybrid: false, opts: {} },
  { label: '混合 + 精排关（旧口径，未接第二段）', hybrid: true, opts: { rerank: false } },
  { label: '混合 + 精排开（★新接线，走生产入口）', hybrid: true, opts: {} },
  { label: '混合 + 精排开 + docMode=id', hybrid: true, opts: { docMode: 'id' } },
  { label: '混合 + 精排开 + semWeight=1.5', hybrid: true, opts: { semWeight: 1.5 } },
];
// 注：`chunkRecall` 变体**刻意不纳入**——它在 `recallKnobs` 已记录为「噪声（minilm +0.2pp）/
// 有害（e5-large −0.8pp）」，且需对 7787 个函数体各切一个 chunk（实测单次构建 >13min 编码税）。
// 已知结论的变体不再重复付费。

const results = [];
let baselinePerQuery = null;

for (const sc of scenarios) {
  const t0 = Date.now();
  const perQuery = [];
  for (const { q } of QUERIES) {
    const opts = { fileK: FILE_K, symK: SYM_K, ...sc.opts };
    const text = sc.hybrid
      ? await engine.getHybridRepoMapContext(SRC, q, embedding, opts)
      : engine.getRepoMapContext(SRC, q, opts);
    const files = filesOf(text);
    const gt = gts.get(q);
    perQuery.push({
      q,
      hit: files.some((f) => gt.has(f)) ? 1 : 0,
      files,
      tokens: tokenize(text ?? '').length,
    });
  }
  const dt = ((Date.now() - t0) / 1000).toFixed(1);
  const hits = perQuery.map((r) => r.hit);
  const mean = (hits.reduce((a, b) => a + b, 0) / hits.length) * 100;
  const avgTok = Math.round(perQuery.reduce((a, r) => a + r.tokens, 0) / perQuery.length);

  if (baselinePerQuery === null) baselinePerQuery = perQuery;
  const diffs = perQuery.map((r, i) => r.hit - baselinePerQuery[i].hit);
  const moved = diffs.reduce((a, b) => a + Math.abs(b), 0) / 2;
  const ci = pairedBootstrap(diffs);

  const line = {
    label: sc.label,
    hitRate: +mean.toFixed(1),
    delta: ci.mean,
    ci: [ci.lo, ci.hi],
    significant: ci.lo > 0 || ci.hi < 0,
    changedQueries: moved,
    avgTokens: avgTok,
    buildSeconds: +dt,
  };
  results.push({ ...line, perQuery: perQuery.map((r) => ({ q: r.q, hit: r.hit })) });

  const flag = line.significant ? (ci.mean > 0 ? '✅ 显著正' : '❌ 显著负') : '·  不显著';
  console.log(
    `  ${sc.label.padEnd(38)} hitRate=${String(line.hitRate).padStart(5)}%  ` +
      `Δ=${String(line.delta).padStart(5)}pp [${ci.lo}, ${ci.hi}]  ${flag}  ` +
      `变动 ${moved}/33  平均 ${avgTok} tok  ${dt}s`,
  );
}

// —— 失败模式对照：基线漏掉的条，混合是否捞回 ——
const baseMiss = baselinePerQuery.map((r, i) => (r.hit === 0 ? i : -1)).filter((i) => i >= 0);
console.log(`\n=== 失败模式对照（基线漏掉 ${baseMiss.length}/33 条）===`);
const best = results[1];
let recovered = 0;
for (const i of baseMiss) {
  const q = baselinePerQuery[i].q;
  const now = best.perQuery[i].hit === 1 ? '捞回' : '仍漏';
  if (best.perQuery[i].hit === 1) recovered++;
  console.log(`  [${now}] ${q}`);
}
console.log(`  混合（默认旋钮）捞回 ${recovered}/${baseMiss.length} 条`);

const report = {
  generatedAt: new Date().toISOString(),
  model: {
    preset: PRESET,
    id: embedding.inner.modelId,
    dim: embedding.dim,
    remoteHost: embedding.inner.remoteHostUsed ?? null,
  },
  vectorCache: {
    prefix: join(VEC_CACHE, `${PRESET}-${FILE_K}`),
    hits: embedding.hits,
    misses: embedding.misses,
  },
  cacheDir: CACHE_DIR,
  corpus: { files: corpus.files.length, symbols: corpus.symbols.length },
  config: { fileK: FILE_K, symK: SYM_K, queryCount: QUERIES.length },
  results,
  failureMode: { baselineMissed: baseMiss.length, recoveredByHybridDefault: recovered },
};
writeFileSync(
  new URL('./semantic-recall-ab.report.json', import.meta.url),
  JSON.stringify(report, null, 2),
);
console.log('\nWrote evals/semantic-recall-ab.report.json');
console.log(`向量缓存：命中 ${embedding.hits} / 回源 ${embedding.misses}`);
