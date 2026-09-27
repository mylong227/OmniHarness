#!/usr/bin/env node
// 语义嵌入路 A/B —— **跨仓库版**（L3 证据层，2026-09-27）。
//
// 与 `semantic-recall-ab.mjs`（仓内单语料）的分工：那一份回答「语义信号在本仓 src/ 上值多少」，
// 本份把同一问题放到 5 个外部真实仓库（Python，异构语料）上——语义路的价值此前只有 L2 证据，
// 且「精排/语义路默认开」之争的共同根因是**判定力不足**。跨仓 60 条查询 + 5 语料是 ①「接语义
// 信号」臂在 L3 上的实测。
//
// 口径（与仓内版同源）：
//   基线 = `getRepoMapContext(root, q, { fileK, rerank })`（纯 BM25，生产入口）
//   实验 = `getHybridRepoMapContext(root, q, embedding, { fileK, rerank })`（BM25 ∪ 语义，RRF）
//   场景三档：基线 / 混合+精排关（旧口径）/ 混合+精排开（新接线）——第二基准点用于区分
//   「融合层没改变结果」与「精排层把差异抹平」（沿用 semantic-recall-ab 2026-09-25 修正 ①②）。
//
// 守卫（缺一不可，2026-09-25 实测踩过假信号）：
//   A. 接线活性：嵌入端口零调用 = 混合路被静默旁路 ⇒ fail-closed 退出，不产出报告；
//   B. 向量缓存目录必须可写（EPERM 会把「构建失败」吞成「回落纯 BM25」⇒ 全部 Δ=0 的假阴性）。
//
// 用法：node evals/semantic-crossrepo.mjs [preset=e5-small-v2]
// 产物：evals/semantic-crossrepo.report.json + 控制台摘要；进度同步写 eval-data/semantic-crossrepo-progress.log

import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { existsSync, mkdirSync, writeFileSync, appendFileSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const DIST = join(ROOT, 'dist', 'src');
const importDist = (...s) => import(pathToFileURL(join(DIST, ...s)).href);

const { ContextEngine } = await importDist('context', 'contextEngine.js');
const { RepoMapContextEngine } = await importDist('context', 'repoMapContextEngine.js');
const { TransformersEmbeddingAdapter } = await importDist(
  'adapters',
  'embedding',
  'transformersEmbeddingAdapter.js',
);
const { CachedEmbeddingPort } = await import('./lib/embedding-cache.mjs');
const { CROSS_REPO_CORPORA } = await import(
  pathToFileURL(join(ROOT, 'dist', 'tests', 'fixtures', 'recallQueriesCrossRepo.js')).href
);

const PLOG = join(ROOT, 'eval-data', 'semantic-crossrepo-progress.log');
const log = (m) => {
  appendFileSync(PLOG, `${new Date().toISOString()} ${m}\n`);
  console.log(m);
};
writeFileSync(PLOG, `start ${new Date().toISOString()}\n`);

const PRESET = process.argv[2] ?? 'e5-small-v2';
const FILE_K = 14; // 与词法跨仓仪器（recall-crossrepo.mjs）同一判定档
const CACHE_DIR =
  process.env.OMNI_EMBEDDING_CACHE_DIR ??
  (existsSync('D:/deepseek/.omni-model-cache')
    ? 'D:/deepseek/.omni-model-cache'
    : join(ROOT, '.omniharness', 'model-cache'));
const VEC_CACHE = process.env.OMNI_VEC_CACHE ?? join(ROOT, 'eval-data', 'vec-cache');
mkdirSync(VEC_CACHE, { recursive: true });

log(`preset=${PRESET} fileK=${FILE_K} cacheDir=${CACHE_DIR} vecCache=${VEC_CACHE}`);

const engine = new RepoMapContextEngine();

// 嵌入端口：磁盘缓存包装 + 调用计数（接线活性守卫用）。
let embedCalls = 0;
const embedding = new CachedEmbeddingPort(
  new TransformersEmbeddingAdapter({
    preset: PRESET,
    cacheDir: CACHE_DIR,
    remoteHost: process.env.OMNI_HF_ENDPOINT ?? process.env.HF_ENDPOINT,
    localFilesOnly: process.env.OMNI_EMBEDDING_OFFLINE === '1',
  }),
  join(VEC_CACHE, `xrepo-${PRESET}-${FILE_K}`),
);
const countingEmbedding = {
  get dim() {
    return embedding.dim;
  },
  async embed(texts) {
    embedCalls += 1;
    return embedding.embed(texts);
  },
};
log(`模型：${embedding.inner.modelId}（${embedding.dim} 维）`);

const filesOf = (text) =>
  text === null
    ? []
    : text
        .split('\n')
        .filter((l) => l.startsWith('📄 '))
        .map((l) => l.replace(/^📄\s*/, '').trim());
const recallOf = (gt, surfaced) =>
  gt.size === 0 ? 0 : [...gt].filter((f) => surfaced.has(f)).length / gt.size;
const avg = (xs) => (xs.length === 0 ? 0 : xs.reduce((s, x) => s + x, 0) / xs.length);

function pairedBootstrap(diffs, B = 4000) {
  const n = diffs.length;
  const mean = diffs.reduce((a, b) => a + b, 0) / n;
  let seed = 0x9e3779b9;
  const rnd = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
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
    meanPp: +(mean * 100).toFixed(1),
    loPp: +(means[Math.floor(B * 0.025)] * 100).toFixed(1),
    hiPp: +(means[Math.floor(B * 0.975)] * 100).toFixed(1),
  };
}

const SCENARIOS = [
  { label: '基线（纯 BM25，精排关）', hybrid: false, opts: { rerank: false } },
  { label: '混合 + 精排关（旧口径）', hybrid: true, opts: { rerank: false } },
  { label: '混合 + 精排开（新接线）', hybrid: true, opts: { rerank: true } },
];

const perRepo = [];
const pooledRecalls = SCENARIOS.map(() => []);

for (const { repo, root, queries } of CROSS_REPO_CORPORA) {
  const abs = join(ROOT, root);
  const corpus = ContextEngine.indexCorpus(abs, { morph: true, light: true });
  log(
    `\n=== ${repo}（${corpus.files.length} 文件 / ${corpus.symbols.length} 符号，${queries.length} 条）===`,
  );
  const gtOf = (anchor) => {
    const needle = anchor.toLowerCase();
    const out = new Set();
    for (const [rel, text] of corpus.fileText) {
      if (text.toLowerCase().includes(needle)) out.add(rel);
    }
    return out;
  };
  const items = [];
  for (const { q, anchor } of queries) {
    const gt = gtOf(anchor);
    if (gt.size === 0) throw new Error(`锚点不存在（GT=0）：${repo} "${anchor}"`);
    items.push({ q, gt });
  }

  const scenarioRecalls = [];
  for (const [si, sc] of SCENARIOS.entries()) {
    const recalls = [];
    for (const it of items) {
      const text = sc.hybrid
        ? await engine.getHybridRepoMapContext(abs, it.q, countingEmbedding, {
            fileK: FILE_K,
            ...sc.opts,
          })
        : await engine.getRepoMapContext(abs, it.q, { fileK: FILE_K, ...sc.opts });
      recalls.push(recallOf(it.gt, new Set(filesOf(text))));
    }
    scenarioRecalls.push(recalls);
    pooledRecalls[si].push(...recalls);
    log(`  ${sc.label}: 召回 ${(avg(recalls) * 100).toFixed(1)}%`);
  }
  // 守卫 A′：引擎对嵌入/索引异常会**静默回落纯 BM25**（设计如此），此时「混合」与基线逐字相同、
  // 三档 Δ 全为 0 ——与「语义路无效」长得一模一样（2026-09-25 踩过这个假阴性）。
  // 故一旦回落计数 > 0 就 fail-closed 退出，不产出会被误读为结论的报告。
  if (engine.semanticFallbackTotal() > 0) {
    console.error(
      `❌ 接线活性守卫 A′：\`${repo}\` 期间语义路回落纯 BM25 ${engine.semanticFallbackTotal()} 次` +
        '（嵌入/索引失败被静默吞掉）——Δ=0 是设施故障而非结论，报告不产出（fail-closed）。',
    );
    process.exit(1);
  }
  // 两两差值（对基线），每仓三档两两各一条 bootstrap。
  const comparisons = [];
  for (let si = 1; si < SCENARIOS.length; si++) {
    const diffs = items.map((_, i) => scenarioRecalls[si][i] - scenarioRecalls[0][i]);
    comparisons.push({
      vs: SCENARIOS[si].label,
      ...pairedBootstrap(diffs),
      up: diffs.filter((d) => d > 1e-9).length,
      down: diffs.filter((d) => d < -1e-9).length,
    });
    log(`  Δ ${SCENARIOS[si].label}: ${JSON.stringify(comparisons[comparisons.length - 1])}`);
  }
  perRepo.push({
    repo,
    files: corpus.files.length,
    queries: items.length,
    recallByScenario: scenarioRecalls.map((r) => +(avg(r) * 100).toFixed(1)),
    comparisons,
  });
}

if (embedCalls === 0) {
  console.error('❌ 接线活性守卫：嵌入端口零调用——混合路被静默旁路，报告不产出（fail-closed）。');
  process.exit(1);
}

// 跨仓合并（L3 主判据）。
log('\n=== 跨仓合并（主判据）===');
const pooled = [];
for (let si = 1; si < SCENARIOS.length; si++) {
  const diffs = pooledRecalls[si].map((r, i) => r - pooledRecalls[0][i]);
  const stat = pairedBootstrap(diffs);
  pooled.push({ vs: SCENARIOS[si].label, ...stat, n: diffs.length });
  log(`  Δ ${SCENARIOS[si].label}: ${JSON.stringify(stat)}（n=${diffs.length}）`);
}

const report = {
  eval: 'semantic-crossrepo',
  purpose: 'L3：语义信号（BM25 ∪ 语义 RRF）的召回价值在 5 个外部真实仓库上的复现检验',
  generatedAt: new Date().toISOString(),
  preset: PRESET,
  fileK: FILE_K,
  path: 'production: getRepoMapContext / getHybridRepoMapContext',
  querySource: 'tests/fixtures/recallQueriesCrossRepo.ts（60 条）',
  embedCalls,
  semanticFallbacks: engine.semanticFallbackTotal(),
  vectorCache: VEC_CACHE,
  perRepo,
  pooled,
  note: '向量缓存按文本粒度跨仓共享（键=模型+角色+归一化+文本哈希），每条文本只编码一次。',
};
writeFileSync(
  new URL('./semantic-crossrepo.report.json', import.meta.url),
  JSON.stringify(report, null, 2),
);
log('\nWrote evals/semantic-crossrepo.report.json');
