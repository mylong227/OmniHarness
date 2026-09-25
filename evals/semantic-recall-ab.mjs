#!/usr/bin/env node
// 语义嵌入路 A/B：真实 ONNX 模型（本地缓存 / hf-mirror）对 33 条对抗锚点查询的召回增益实测。
//
// 背景：语义路（`getHybridRepoMapContext`）此前**只在评测脚本里可用**——脚本自行设 `env.remoteHost`，
// 而生产装配路径（`configFactory`）无对应旋钮 ⇒ 在无法直连 huggingface.co 的网络里必然不可达。
// 本轮补齐了 `remoteHost` 旋钮（`OMNI_HF_ENDPOINT` / `HF_ENDPOINT`），故本实验**走生产入口**：
//   基线 = `engine.getRepoMapContext(root, q)`（纯 BM25 + K=20 + 梯度投送，`rerank` 显式给定）
//   实验 = `engine.getHybridRepoMapContext(root, q, embedding, opts)`（BM25 ∪ 语义，RRF 融合）
// 两者都从返回文本解析 `📄 路径` 行得到**文件秩**，与实际注入给模型的集合完全一致。
//
// ⚠️ 两处 2026-09-25 修正（此前会给出假信号）：
//   ① **`rerank` 必须显式给**：§21.2 已把精排默认**回关为 opt-in**，而本脚本的场景此前靠「默认值」，
//      于是「混合 + 精排开」三档实际跑的是**精排关**——标签与事实不符。现全部显式 `rerank: true/false`。
//   ② **接线活性守卫**：`getHybridRepoMapContext` 对嵌入层异常**fail-closed 静默回落纯 BM25**，
//      嵌入端口根本没被调用时，全部场景会显示 Δ=0（假阴性，而非「语义路无效」）。故新增守卫：
//      嵌入端口零调用即 fail-closed 退出，不产出报告。
//
// 用法（免付费、免 LLM key；模型权重可走本地缓存 + hf-mirror 的元数据）：
//   OMNI_VEC_CACHE=<可写目录> OMNI_HF_ENDPOINT=https://hf-mirror.com node evals/semantic-recall-ab.mjs [preset]
//   OMNI_EMBEDDING_OFFLINE=1 OMNI_EMBEDDING_CACHE_DIR=<模型缓存> node evals/semantic-recall-ab.mjs
// ⚠️ `OMNI_VEC_CACHE` **必须可写**：默认值 `D:/deepseek/.omni-vec-cache` 在本仓沙箱下位于 workspace 之外，
//    写入被拒（EPERM）→ `SemanticIndexCache.build` 的 catch 吞成「构建失败」→ 引擎静默 fail-closed 回落纯 BM25
//    ⇒ 全部 Δ=0 且**看不出是环境问题**（2026-09-25 实测踩中，已由脚本末尾守卫 B 拦下）。沙箱内请指到
//    `./eval-data/vec-cache`（可先把历史缓存文件拷进来复用，省一次全语料编码）。
// 输出：evals/semantic-recall-ab.report.json + 控制台摘要。

import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { existsSync, writeFileSync } from 'node:fs';

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
// 默认值全部落在**仓库内**（workspace 可写），不再指向 `D:/deepseek/.omni-*`：那两个路径在受限沙箱里
// 位于 workspace 之外，写入被拒（EPERM）→ `CachedEmbeddingPort.flush` 抛错 → 索引构建失败被 catch 吞掉 →
// 引擎静默 fail-closed 回落纯 BM25 ⇒ 全部 Δ=0 的**假阴性**（2026-09-25 实测踩中）。历史缓存仍可用：
// 把 `e5-small-v2-20.{f32,keys}` 拷进 `eval-data/vec-cache/` 即复用它，省一次全语料编码。
const CACHE_DIR =
  process.env.OMNI_EMBEDDING_CACHE_DIR ??
  (existsSync('D:/deepseek/.omni-model-cache')
    ? 'D:/deepseek/.omni-model-cache'
    : join(ROOT, '.omniharness', 'model-cache'));
const VEC_CACHE = process.env.OMNI_VEC_CACHE ?? join(ROOT, 'eval-data', 'vec-cache');

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
  { label: '基线（纯 BM25 + 精排 + K=20 + 梯度）', hybrid: false, opts: { rerank: true } },
  // 第二个基准点（2026-09-25 补）：没有它就无法区分「语义融合本身没改变结果」与「只是精排把差异抹平」——
  // 有它才能定位 Δ=0 的层次（融合层 vs 精排层）。行序在第 1 行之后 ⇒ 仍以第 1 行为对照基准。
  { label: '基线（纯 BM25 + 精排关）', hybrid: false, opts: { rerank: false } },
  { label: '混合 + 精排关（旧口径，未接第二段）', hybrid: true, opts: { rerank: false } },
  { label: '混合 + 精排开（★新接线，走生产入口）', hybrid: true, opts: { rerank: true } },
  { label: '混合 + 精排开 + docMode=id', hybrid: true, opts: { rerank: true, docMode: 'id' } },
  {
    label: '混合 + 精排开 + semWeight=1.5',
    hybrid: true,
    opts: { rerank: true, semWeight: 1.5 },
  },
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
      text: text ?? '',
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
  results.push({
    ...line,
    perQuery: perQuery.map((r) => ({ q: r.q, hit: r.hit, files: r.files, text: r.text })),
  });

  const flag = line.significant ? (ci.mean > 0 ? '✅ 显著正' : '❌ 显著负') : '·  不显著';
  console.log(
    `  ${sc.label.padEnd(38)} hitRate=${String(line.hitRate).padStart(5)}%  ` +
      `Δ=${String(line.delta).padStart(5)}pp [${ci.lo}, ${ci.hi}]  ${flag}  ` +
      `变动 ${moved}/${QUERIES.length}  平均 ${avgTok} tok  ${dt}s`,
  );
}

// —— 失败模式对照：基线漏掉的条，混合是否捞回 ——
const baseMiss = baselinePerQuery.map((r, i) => (r.hit === 0 ? i : -1)).filter((i) => i >= 0);
// 按标签定位而非下标（2026-09-25 起场景表有多个基准点，下标会随插入漂移）。
const best = results.find((r) => r.label.startsWith('混合 + 精排开（'));
if (best === undefined) throw new Error('场景表缺少「混合 + 精排开」行：无法做失败模式对照');
console.log(`\n=== 失败模式对照（基线漏掉 ${baseMiss.length}/33 条）===`);
let recovered = 0;
for (const i of baseMiss) {
  const q = baselinePerQuery[i].q;
  const now = best.perQuery[i].hit === 1 ? '捞回' : '仍漏';
  if (best.perQuery[i].hit === 1) recovered++;
  console.log(`  [${now}] ${q}`);
}
console.log(`  ${best.label} 捞回 ${recovered}/${baseMiss.length} 条`);

// —— 融合层活性：同 `rerank` 状态下，「混合」与「纯 BM25」的**完整注入文本**是否逐字相同 ——
// 只比 hit 向量或文件集合都不够（符号大纲可能变而文件不变），必须比注入文本本体，
// 才能区分「语义候选真的没参与排序」与「重排把差异抹平 / 命中恰好重合」。
console.log('\n=== 融合层活性（混合 vs 纯 BM25，同 rerank 状态，完整注入文本逐条比对）===');
let identicalStates = 0;
for (const [pureLabel, hybridLabel, state] of [
  ['基线（纯 BM25 + 精排关）', '混合 + 精排关（旧口径，未接第二段）', '精排关'],
  ['基线（纯 BM25 + 精排 + K=20 + 梯度）', '混合 + 精排开（★新接线，走生产入口）', '精排开'],
]) {
  const pure = results.find((r) => r.label === pureLabel);
  const hyb = results.find((r) => r.label === hybridLabel);
  if (pure === undefined || hyb === undefined) continue;
  let sameText = 0;
  for (let i = 0; i < pure.perQuery.length; i++) {
    if (pure.perQuery[i].text === hyb.perQuery[i].text) sameText++;
  }
  if (sameText === pure.perQuery.length) identicalStates += 1;
  console.log(
    `  ${state}：注入文本逐字相同 ${sameText}/${pure.perQuery.length}` +
      (sameText === pure.perQuery.length
        ? ' ⇒ 语义候选未进入注入内容（**零贡献**，或 fail-closed 回落——见下节守卫）'
        : ' ⇒ 语义候选确参与排序'),
  );
}

// —— 守卫 A（fail-closed）：嵌入端口零调用 ⇒ 上表所有 Δ 都是 fail-closed 回落的假阴性 ——
// 根因（2026-09-25 实测）：`getHybridRepoMapContext` 对嵌入层异常**静默**回落纯 BM25，
// 模型加载失败（离线缓存缺元数据 / 网络不可达）时全部场景与基线逐字相同、Δ=0、「不显著」——
// 这与「语义路无效」在报告里长得一模一样，正是本仓反复治的假信号。故零调用即拒绝出报告。
if (embedding.hits + embedding.misses === 0) {
  console.error(
    '\n❌ 接线失效：嵌入端口零调用（向量缓存 命中 0 / 回源 0）⇒ 混合路径是 fail-closed 回落纯 BM25，' +
      '上表 Δ 全为**假阴性**，不构成「语义路无效」的证据。\n' +
      '   排查：① 能否加载模型（OMNI_HF_ENDPOINT=https://hf-mirror.com 或 OMNI_EMBEDDING_CACHE_DIR 指向完整缓存）；' +
      '② 是否被本沙箱阻断（子进程/网络）。',
  );
  process.exit(1);
}

// —— 守卫 B（fail-closed）：端口有调用但**注入文本仍逐字相同** ⇒ 索引构建失败被 build 的 catch 吞掉 ——
// 实测根因（2026-09-25，本仓沙箱）：评测侧向量缓存默认写在 `D:/deepseek/.omni-vec-cache`（**workspace 之外**），
// 沙箱拒绝写入 ⇒ `CachedEmbeddingPort.flush` 抛 EPERM ⇒ `SemanticIndexCache.build` 的 `catch { return null }`
// 把它吞成「构建失败」⇒ 引擎 fail-closed 回落纯 BM25。此时**端口计数不为 0**（守卫 A 不触发），
// 而全部 Δ=0 —— 一个看起来像「语义路无效」的纯环境假阴性。故：逐字相同即拒绝出报告。
if (identicalStates === 2 && process.env.OMNI_ALLOW_ZERO_SEMANTIC !== '1') {
  console.error(
    '\n❌ 语义路未进入注入内容：两个 rerank 状态下「混合」与纯 BM25 的注入文本**逐条逐字相同**。\n' +
      '   这通常不是「语义路无效」，而是索引构建失败被静默 fail-closed（典型：向量缓存目录不可写 →' +
      ' EPERM → build 返回 null）。\n' +
      '   排查：① OMNI_VEC_CACHE 指向**可写**目录（沙箱下必须在 workspace 内，如 ./eval-data/vec-cache）；' +
      '② 模型可加载（OMNI_HF_ENDPOINT / OMNI_EMBEDDING_CACHE_DIR）。\n' +
      '   若已确认是真实零贡献，显式设 OMNI_ALLOW_ZERO_SEMANTIC=1 再跑（该判定须同时写进报告/看板）。',
  );
  process.exit(1);
}

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
