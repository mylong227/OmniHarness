#!/usr/bin/env node
/**
 * 检索命中率探针（G21 提升入库，2026-10-03；2026-10-24 增加 hybrid 双镜头）。
 *
 * ## 回答什么问题
 *
 * 「生产口径（`fileK` + 可选精排）下，冻结查询集的 hitRate@K 是多少，95% CI 有多宽」——
 * 这是本仓所有检索改动的**基线量**；没有它就分不清"改动有效"与"查询集噪声"。
 *
 * 2026-10-24 起支持两条镜头：
 * - `bm25`（默认，离线、免模型、确定性）——保护回退路径；
 * - `hybrid`（真嵌入 + RRF，生产 agent 默认路径）——保护**默认路径**；
 * - `both` 同一进程跑两条并输出 Δ，CI 仍按各自配对样本计算；
 * - `symbol`（2026-10-29，A9）符号级镜头：查询 = 导出符号名，GT = 唯一定义该符号的文件，
 *   度量「按符号定位定义文件」的 hitRate@K（文件级 GT 的符号化补充，不是语义理解）。
 *
 * ## 口径（与 `tests/unit/retrievalBaseline.test.ts` 同源）
 *
 * - 语料：仓库 `src/`（`morph` 开、`light` 档，与生产默认一致）；
 * - 查询：`tests/fixtures/recallQueries.ts`（冻结 `core` 段 + 扩样 `ext` 段）；
 * - GT：由「文件正文包含锚点字面量」**机械推出**，不依赖 BM25 ⇒ 无自证循环；
 * - hybrid 从 `getHybridRepoMapContext` **渲染文本**解析文件路径（agent 真正看到的上下文），
 *   比内部 ranked 更贴近使用侧；
 * - 统计：hitRate + **配对 bootstrap 95% CI**（2000 次重采样，固定种子 ⇒ 可复现）。
 *
 * ## 前置
 *
 * 需要编译产物：先 `npm run build`（本探针 import `dist/src/**` 与 `dist/tests/fixtures/**`）。
 * hybrid 还需要 minilm 权重（约 23MB，首次下载；之后走 `.cache/omni-embed-vectors`）。
 *
 * ## 用法
 *
 * ```bash
 * node tools/probes/recallHitrate.mjs                       # 纯 BM25，fileK=30
 * node tools/probes/recallHitrate.mjs --lens=hybrid         # 生产默认混合路径
 * node tools/probes/recallHitrate.mjs --lens=both --strict   # 双镜头 + fallback/回归断言
 * node tools/probes/recallHitrate.mjs --lens=hybrid --rerank=1 --json=out.json
 * node tools/probes/recallHitrate.mjs --lens=hybrid --preset=minilm
 * node tools/probes/recallHitrate.mjs --lens=symbol             # 符号级 hitRate@K（A9）
 * ```
 *
 * ## 诚实边界
 *
 * - 只测**文件级命中**（GT 文件是否进 Top-K），不测符号级精确率；
 * - `core` 段是冻结集（跨版本可比），`ext` 段是扩样集（可比性弱于 core）；
 * - 数字随语料变化而变（`src/` 每加文件都会影响召回）⇒ **跨提交比较必须同语料**；
 * - hybrid 的 `semanticFallbacks>0` 表示有查询静默退化为 BM25，数字含水分；`--strict` 会直接失败。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { probeArgs } from './_args.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
/** 仓库根（本文件在 `tools/probes/` 下，故上溯两级）。 */
const ROOT = join(HERE, '..', '..');
const importDist = (...segments) =>
  import(pathToFileURL(join(ROOT, 'dist', 'src', ...segments)).href);

// 参数解析排在 dist 动态 import **之前**（理由见 `_args.mjs` 头注释：旗标错不该被
// "缺少编译产物"盖住）。`--rerank` 既接受裸开关也接受 `--rerank=1`。
const a = probeArgs({
  values: { fileK: '30', json: '', lens: 'bm25', preset: 'minilm' },
  flags: { rerank: false, strict: false },
});
const FILE_K = Number(a.fileK);
const RERANK = a.rerank === true;
const LENS = String(a.lens);
const PRESET = String(a.preset);
const JSON_OUT = String(a.json);
const STRICT = a.strict === true;
if (!Number.isInteger(FILE_K) || FILE_K <= 0) {
  console.error('✗ --fileK 必须是正整数（例：--fileK=14）');
  process.exit(2);
}
if (!['bm25', 'hybrid', 'both', 'symbol'].includes(LENS)) {
  console.error('✗ --lens 只能是 bm25 / hybrid / both / symbol');
  process.exit(2);
}

let RECALL_QUERIES;
let CORE_COUNT;
let ContextEngine;
let RepoMapContextEngine;
let TransformersEmbeddingAdapter;
let DiskCachedEmbeddingAdapter;
try {
  ({ RECALL_QUERIES, CORE_COUNT } = await import(
    pathToFileURL(join(ROOT, 'dist', 'tests', 'fixtures', 'recallQueries.js')).href
  ));
  ({ ContextEngine } = await importDist('context', 'contextEngine.js'));
  if (LENS !== 'bm25') {
    ({ RepoMapContextEngine } = await importDist('context', 'repoMap', 'repoMapContextEngine.js'));
    ({ TransformersEmbeddingAdapter } = await importDist(
      'adapters',
      'embedding',
      'transformersEmbeddingAdapter.js',
    ));
    ({ DiskCachedEmbeddingAdapter } = await importDist(
      'adapters',
      'embedding',
      'diskCachedEmbeddingAdapter.js',
    ));
  }
} catch (error) {
  console.error(
    '✗ 缺少编译产物。请先运行 `npm run build`（本探针需要 dist/src/** 与 dist/tests/fixtures/**）。\n' +
      `  原因：${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(2);
}

const SRC_ROOT = join(ROOT, 'src');
const VEC_CACHE =
  process.env.OMNI_EMBEDDING_CACHE_DIR ?? join(ROOT, '.cache', 'omni-embed-vectors');
const corpus = ContextEngine.indexCorpus(SRC_ROOT, { morph: true, light: true });
const rels = [...corpus.fileText.keys()];

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

/**
 * 符号级用例（A9）：从 `src/` 真实导出声明推导「符号名 → 唯一定义文件」。
 * 只取**单文件定义**（同名多处定义会歧义，直接跳过），按名字排序取前 120 条。
 * @returns {{i:number, core:boolean, q:string, gt:Set<string>}[]} 符号用例。
 */
function symbolCases() {
  const re =
    /^export\s+(?:abstract\s+)?(?:class|function|const|interface|type|enum)\s+([A-Za-z_$][\w$]*)/gmu;
  const byName = new Map();
  for (const [rel, text] of corpus.fileText) {
    for (const match of text.matchAll(re)) {
      const name = match[1];
      if (name === undefined) continue;
      const files = byName.get(name) ?? new Set();
      files.add(rel);
      byName.set(name, files);
    }
  }
  return [...byName.entries()]
    .filter(([, files]) => files.size === 1)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .slice(0, 120)
    .map(([name, files], i) => ({ i, core: false, q: name, gt: files }));
}

const CASES = [];
if (LENS === 'symbol') {
  CASES.push(...symbolCases());
  if (CASES.length === 0) throw new Error('符号级镜头未找到任何唯一导出符号');
} else {
  for (let i = 0; i < RECALL_QUERIES.length; i += 1) {
    const { q, anchor } = RECALL_QUERIES[i];
    const gt = groundTruth(anchor);
    if (gt.size === 0) throw new Error(`锚点不存在（GT=0）：query="${q}" anchor="${anchor}"`);
    CASES.push({ i, core: i < CORE_COUNT, q, gt });
  }
}

/** BM25 镜头（离线、无模型）。 */
function bm25Rows() {
  return CASES.map(({ i, core, q, gt }) => {
    const result = ContextEngine.query(corpus, q, { fileK: FILE_K, rerank: RERANK });
    const ranked = result.ranked ?? result.files ?? [];
    const top = ranked.slice(0, FILE_K);
    return {
      i,
      core,
      q,
      hit: top.some((rel) => gt.has(rel)) ? 1 : 0,
      bestRank: ranked.findIndex((rel) => gt.has(rel)) + 1 || -1,
    };
  });
}

/** 从渲染文本解析出现的 rel 路径（按首次出现序）。 */
function filesInText(text) {
  const found = [];
  for (const rel of rels) if (text.includes(rel)) found.push(rel);
  return found;
}

/** hybrid 镜头（真嵌入 + RRF；模型不可用直接 exit 3，绝不假装 BM25）。 */
async function hybridRows() {
  mkdirSync(VEC_CACHE, { recursive: true });
  const inner = new TransformersEmbeddingAdapter({
    preset: PRESET,
    cacheDir: join(VEC_CACHE, 'models', PRESET),
    remoteHost: TransformersEmbeddingAdapter.resolveRemoteHostFromEnv(),
    localFilesOnly: process.env.OMNI_EMBEDDING_OFFLINE === '1',
  });
  const embedding = new DiskCachedEmbeddingAdapter({
    inner,
    cacheDir: join(VEC_CACHE, 'vectors'),
  });
  const engine = new RepoMapContextEngine();
  // 仪器自证：先真嵌一条并核维度；失败当场报错，绝不让长跑后才发现 191/191 全回落。
  try {
    const warm = await embedding.embed(['probe self-check'], { role: 'query' });
    if (warm[0]?.length !== inner.dim) {
      throw new Error(`嵌入维度异常：期望 ${String(inner.dim)}，实得 ${String(warm[0]?.length)}`);
    }
    console.log(`自检通过：dim=${String(inner.dim)} 模型=${inner.modelId}`);
  } catch (error) {
    console.error(
      `✗ 嵌入自检失败：${error instanceof Error ? error.message : String(error)}\n` +
        '  境外网络不通时请把 OMNI_HF_ENDPOINT 指向镜像源，或 OMNI_EMBEDDING_OFFLINE=1 配预置权重。',
    );
    process.exit(3);
  }
  const rows = [];
  for (const { i, core, q, gt } of CASES) {
    const text = await engine.getHybridRepoMapContext(SRC_ROOT, q, embedding, {
      fileK: FILE_K,
      ...(RERANK ? { rerank: true } : {}),
    });
    const ranked = text === null ? [] : filesInText(text);
    rows.push({
      i,
      core,
      q,
      // 与 semanticHybridRecall 同口径：渲染文本里出现的路径都算可见（文本已由引擎按 fileK 组织）。
      hit: ranked.some((rel) => gt.has(rel)) ? 1 : 0,
      bestRank: ranked.findIndex((rel) => gt.has(rel)) + 1 || -1,
    });
  }
  return { rows, fallbacks: engine.semanticFallbackTotal() };
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

function summarize(rows) {
  const core = rows.filter((r) => r.core);
  const ext = rows.filter((r) => !r.core);
  return {
    all: { n: rows.length, hitRate: rate(rows), ci95: bootstrapCI(rows) },
    core: { n: core.length, hitRate: rate(core), ci95: bootstrapCI(core) },
    ext: { n: ext.length, hitRate: rate(ext), ci95: bootstrapCI(ext) },
    misses: rows
      .filter((r) => r.hit === 0)
      .map((r) => ({ i: r.i, core: r.core, q: r.q, bestRank: r.bestRank })),
  };
}

const report = {
  probe: 'recallHitrate',
  fileK: FILE_K,
  rerank: RERANK,
  lens: LENS,
  corpus: { files: corpus.files.length, symbols: corpus.symbols.length },
};
const pct = (x) => `${(x * 100).toFixed(1)}%`;
function printLine(label, s) {
  console.log(
    `  ${label.padEnd(4)} n=${s.all.n}  hitRate=${pct(s.all.hitRate)} CI[${pct(s.all.ci95[0])}, ${pct(s.all.ci95[1])}]` +
      `  core=${pct(s.core.hitRate)}  ext=${pct(s.ext.hitRate)}`,
  );
}

let bm25;
if (LENS !== 'hybrid') {
  bm25 = summarize(bm25Rows());
  report.bm25 = bm25;
  report.all = bm25.all;
  report.core = bm25.core;
  report.ext = bm25.ext;
  report.misses = bm25.misses;
}

let hybrid;
let fallbacks = 0;
if (LENS === 'hybrid' || LENS === 'both') {
  const result = await hybridRows();
  hybrid = summarize(result.rows);
  fallbacks = result.fallbacks;
  report.hybrid = hybrid;
  report.semanticFallbacks = fallbacks;
  if (LENS === 'hybrid') {
    report.all = hybrid.all;
    report.core = hybrid.core;
    report.ext = hybrid.ext;
    report.misses = hybrid.misses;
  }
}

console.log(
  `fileK=${FILE_K} rerank=${RERANK} lens=${LENS} preset=${PRESET} 语料 ${corpus.files.length} 文件 / ${corpus.symbols.length} 符号`,
);
if (bm25 !== undefined) printLine('bm25', bm25);
if (hybrid !== undefined) printLine('hybrid', hybrid);
if (bm25 !== undefined && hybrid !== undefined) {
  const delta = hybrid.all.hitRate - bm25.all.hitRate;
  report.delta = {
    all: delta,
    core: hybrid.core.hitRate - bm25.core.hitRate,
    ext: hybrid.ext.hitRate - bm25.ext.hitRate,
  };
  console.log(
    `  Δ hybrid-bm25: all ${(delta * 100).toFixed(1)}pp  core ${(report.delta.core * 100).toFixed(1)}pp  ext ${(report.delta.ext * 100).toFixed(1)}pp`,
  );
}
if (LENS === 'hybrid' || LENS === 'both')
  console.log(`  语义回落次数: ${fallbacks}（>0 说明数字含水分）`);
for (const m of report.misses ?? []) {
  console.log(`  MISS ${m.core ? 'core' : 'ext '} #${m.i} bestRank=${m.bestRank} :: ${m.q}`);
}
if (JSON_OUT !== '') {
  writeFileSync(JSON_OUT, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`\n已写出 ${JSON_OUT}`);
}

if (STRICT) {
  if (LENS === 'hybrid' || LENS === 'both') {
    if (fallbacks > 0) {
      console.error(`✗ strict: semanticFallbacks=${fallbacks}（>0 即质量回落，不允许）`);
      process.exit(3);
    }
  }
  if (bm25 !== undefined && hybrid !== undefined) {
    if (hybrid.all.hitRate < bm25.all.hitRate - 0.05) {
      console.error('✗ strict: hybrid all 比 bm25 低超过 5pp（回归）');
      process.exit(3);
    }
    if (hybrid.core.hitRate < bm25.core.hitRate - 0.05) {
      console.error('✗ strict: hybrid core 比 bm25 低超过 5pp（回归）');
      process.exit(3);
    }
  }
}
