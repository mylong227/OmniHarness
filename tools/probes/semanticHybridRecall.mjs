#!/usr/bin/env node
/**
 * 语义混合检索全量实测探针（2026-10-05；离线可复现、权重走镜像缓存）。
 *
 * ## 回答什么问题
 *
 * 真实嵌入模型（minilm，384 维）接入后的混合检索，在**全量 191 条**评测查询上的 hitRate@20
 * 是多少（此前只有 core33 口径：纯混合 75.8% → 混合+精排 81.8%，见 repoMapContextEngine 内注）。
 * 对照组 = 同一查询集的纯 BM25 静态路径（与本探针同语料同 fileK）。
 *
 * ## 口径（诚实边界）
 *
 * - 从 `getHybridRepoMapContext` **渲染文本**中解析出现的文件路径——这是 agent 真正看到的
 *   上下文，比内部 ranked.allFiles 更贴近使用侧；GT = 锚点字面量在文件正文；
 * - 单仓自证：跨仓泛化此前实测 pooled 0.0pp，本探针数字**只对本仓语料负责**；
 * - 权重缓存：`DiskCachedEmbeddingAdapter` 内容寻址落盘，第二次运行零重复嵌入。
 *
 * ## 前置
 *
 * - 需要编译产物：先 `npm run build`；
 * - **需要网络一次**（拉 minilm q8 权重 ≈23MB）：境外不通时设
 *   `OMNI_HF_ENDPOINT` 指向镜像源（hf-mirror.com 的 https 端点；与生产装配同一 env 解析；本探针**不**满足
 *   本目录「免网络」惯例，是首个需要网络的入库探针，故显式声明）；
 * - 向量缓存落 `.cache/omni-embed-vectors/`（gitignored，删掉即全量重嵌）。
 *
 * ## 用法
 *
 * ```bash
 * node tools/probes/semanticHybridRecall.mjs [--fileK=20] [--json=out.json]
 * ```
 *
 * ## 诚实边界
 *
 * - 开跑前有**嵌入自检**（真嵌一条并核维度）：模型加载/下载/落盘任一环节不通当场 exit 3
 *   ——绝不重演「长跑一晚、191/191 静默回落、数字全是纯 BM25」的水分形态（首版踩过）；
 * - 语义回落计数（`engine.semanticFallbackTotal()`）随行打印：>0 即有查询退化成纯 BM25，数字含水分；
 * - 渲染文本路径解析可能重复计入（同文件多次出现）——命中判定是集合语义，不受影响；
 * - **生效旋钮随行打印**（fileK/preset/chunks/rerank）：本探针的 `arg()` 曾被打坏成
 *   `startsWith()`（漏传参数 ⇒ 永不匹配 ⇒ 旗标静默失效），变体读数与基线逐位相同才暴露——
 *   仪器必须回显自己的生效配置，否则「旗标没生效」与「旋钮无效果」不可区分。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const importDist = (...segments) => import(pathToFileURL(join(ROOT, 'dist', ...segments)).href);

/**
 * 读命令行 --name=value。
 * @param {string} name 参数名（不含 --）。
 * @param {string} dflt 缺省值。
 * @returns {string} 值。
 */
const arg = (name, dflt) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit === undefined ? dflt : hit.slice(name.length + 3);
};

const FILE_K = Number(arg('fileK', '20'));
const CHUNKS = arg('chunks', '0') === '1';
const RERANK = arg('rerank', '0') === '1';
const PRESET = arg('preset', 'minilm');
if (!Number.isFinite(FILE_K) || FILE_K <= 0) {
  console.error('✗ --fileK 必须是正整数');
  process.exit(2);
}
console.log(
  `生效旋钮：fileK=${String(FILE_K)} preset=${PRESET} chunks=${String(CHUNKS)} rerank=${String(RERANK)}`,
);
let ContextEngine;
let RepoMapContextEngine;
let TransformersEmbeddingAdapter;
let DiskCachedEmbeddingAdapter;
let RECALL_QUERIES;
let CORE_COUNT;
try {
  ({ ContextEngine } = await importDist('src', 'context', 'contextEngine.js'));
  ({ RepoMapContextEngine } = await importDist(
    'src',
    'context',
    'repoMap',
    'repoMapContextEngine.js',
  ));
  ({ TransformersEmbeddingAdapter } = await importDist(
    'src',
    'adapters',
    'embedding',
    'transformersEmbeddingAdapter.js',
  ));
  ({ DiskCachedEmbeddingAdapter } = await importDist(
    'src',
    'adapters',
    'embedding',
    'diskCachedEmbeddingAdapter.js',
  ));
  ({ RECALL_QUERIES, CORE_COUNT } = await import(
    pathToFileURL(join(ROOT, 'dist', 'tests', 'fixtures', 'recallQueries.js')).href
  ));
} catch (error) {
  // 不吞真实错误：import 失败可能是「编译产物缺失」之外的形态（如模块加载期依赖 CWD 的副作用）。
  console.error(
    `✗ 初始化失败（先确认已 \`npm run build\`；若产物在，则看下方真实原因）：${
      error instanceof Error ? (error.stack ?? error.message) : String(error)
    }`,
  );
  process.exit(2);
}

if (!Number.isFinite(FILE_K) || FILE_K <= 0) {
  console.error('✗ --fileK 必须是正整数');
  process.exit(2);
}
const SRC_ROOT = join(ROOT, 'src');
const VEC_CACHE =
  process.env.OMNI_EMBEDDING_CACHE_DIR ?? join(HERE, '..', '..', '.cache', 'omni-embed-vectors');
mkdirSync(VEC_CACHE, { recursive: true });

const corpus = ContextEngine.indexCorpus(SRC_ROOT, { morph: true, light: true });
const rels = [...corpus.fileText.keys()];

/** 机械 GT：锚点字面量在文件正文（与 bm25TuneSweep / recallHitrate 同口径）。 */
const gtOf = (anchor) => {
  const needle = anchor.toLowerCase();
  const out = new Set();
  for (const [rel, text] of corpus.fileText) {
    if (text.toLowerCase().includes(needle)) out.add(rel);
  }
  return out;
};
const CASES = [];
for (const entry of RECALL_QUERIES) {
  const gt = gtOf(entry.anchor);
  if (gt.size === 0) continue;
  CASES.push({ q: entry.q, gt, tier: CASES.length < CORE_COUNT ? 'core' : 'ext' });
}
console.log(
  `语料 ${String(corpus.files.length)} 文件 ｜ 有效查询 ${String(CASES.length)} 条（core ${String(CORE_COUNT)}）｜ fileK=${String(FILE_K)}\n`,
);

/** 纯 BM25 对照（静态路径，生产同款默认参数）。 */
const baseHit = CASES.map(({ q, gt }) => {
  const res = ContextEngine.query(corpus, q, { fileK: FILE_K });
  return res.files.some((f) => gt.has(f)) ? 1 : 0;
});

/** 从渲染文本解析出现的 rel 路径（按首次出现序）。 */
function filesInText(text) {
  const found = [];
  for (const rel of rels) {
    if (text.includes(rel)) found.push(rel);
  }
  return found;
}

const inner = new TransformersEmbeddingAdapter({
  preset: arg('preset', 'minilm'),
  cacheDir: join(VEC_CACHE, 'models', arg('preset', 'minilm')),
  // 与生产装配同一 env 解析（OMNI_HF_ENDPOINT / HF_ENDPOINT）：漏传会把下载打到
  // huggingface.co——在境内网络即模型加载失败 ⇒ 引擎整段吞错回落纯 BM25（上一轮
  // 191/191 全回落、耗时一晚的根因，正是本行缺失）。
  remoteHost: TransformersEmbeddingAdapter.resolveRemoteHostFromEnv(),
  localFilesOnly: process.env.OMNI_EMBEDDING_OFFLINE === '1',
});
const embedding = new DiskCachedEmbeddingAdapter({
  inner,
  cacheDir: join(VEC_CACHE, 'vectors'),
});
const engine = new RepoMapContextEngine();

// 开跑前自检（仪器自证）：真嵌一条，模型加载/下载/落盘任一环节不通就当场报真错，
// 绝不让长跑结束才发现 191/191 静默回落、拿到全水分数据。
try {
  const warm = await embedding.embed(['probe self-check'], { role: 'query' });
  if (warm[0]?.length !== inner.dim) {
    throw new Error(`嵌入维度异常：期望 ${String(inner.dim)}，实得 ${String(warm[0]?.length)}`);
  }
  console.log(`自检通过：dim=${String(inner.dim)} 模型=${inner.modelId}`);
} catch (error) {
  console.error(
    `✗ 嵌入自检失败：${error instanceof Error ? error.message : String(error)}\n` +
      `  境外网络不通时请把 OMNI_HF_ENDPOINT 指向镜像源（hf-mirror.com 的 https 端点），或 OMNI_EMBEDDING_OFFLINE=1 配预置权重。`,
  );
  process.exit(3);
}

// 变体旋钮（2026-10-05 扩展）：chunks=函数体分块召回（生产默认关）、rerank=第二段词法精排
// （生产默认关）。本探针负责在**全量 191 条**口径上实测它们叠在混合检索上的净效果。
const hybridHit = [];
const t0 = Date.now();
for (const [i, { q, gt }] of CASES.entries()) {
  const text = await engine.getHybridRepoMapContext(SRC_ROOT, q, embedding, {
    fileK: FILE_K,
    ...(CHUNKS ? { chunkRecall: true } : {}),
    ...(RERANK ? { rerank: true } : {}),
  });
  const found = text === null ? [] : filesInText(text);
  hybridHit.push(found.some((f) => gt.has(f)) ? 1 : 0);
  if ((i + 1) % 40 === 0) {
    console.log(
      `  … ${String(i + 1)}/${String(CASES.length)} 条（累计 ${String(Math.round((Date.now() - t0) / 1000))}s）`,
    );
  }
}
const elapsed = Math.round((Date.now() - t0) / 1000);

function rateAt(vec, pred) {
  const pairs = CASES.map((c, i) => ({ c, v: vec[i] })).filter(({ c }) => pred(c));
  if (pairs.length === 0) return 'n/a';
  const rate = (100 * pairs.reduce((a, { v }) => a + v, 0)) / pairs.length;
  return `${rate.toFixed(1)}%（n=${String(pairs.length)}）`;
}

console.log(
  `\n镜头                    纯 BM25            语义混合（minilm）\n` +
    `all                    ${rateAt(baseHit, () => true).padEnd(20)} ${rateAt(hybridHit, () => true)}\n` +
    `core（冻结）           ${rateAt(baseHit, (c) => c.tier === 'core').padEnd(20)} ${rateAt(hybridHit, (c) => c.tier === 'core')}\n` +
    `ext（对抗）            ${rateAt(baseHit, (c) => c.tier === 'ext').padEnd(20)} ${rateAt(hybridHit, (c) => c.tier === 'ext')}`,
);
console.log(
  `\n耗时 ${String(elapsed)}s ｜ 语义回落次数 ${String(engine.semanticFallbackTotal())}（>0 说明有查询静默退化成纯 BM25，数字含水分）`,
);

const JSON_OUT = arg('json', '');
if (JSON_OUT !== '') {
  const out = JSON_OUT;
  writeFileSync(
    out,
    `${JSON.stringify(
      {
        probe: 'semanticHybridRecall',
        preset: PRESET,
        chunks: CHUNKS,
        rerank: RERANK,
        fileK: FILE_K,
        corpus: { files: corpus.files.length, symbols: corpus.symbols.length },
        baseline: baseHit.reduce((a, b) => a + b, 0) / baseHit.length,
        hybrid: hybridHit.reduce((a, b) => a + b, 0) / hybridHit.length,
        perQuery: CASES.map((c, i) => ({
          q: c.q,
          tier: c.tier,
          base: baseHit[i],
          hybrid: hybridHit[i],
        })),
        elapsedSec: elapsed,
        semanticFallbacks: engine.semanticFallbackTotal(),
      },
      null,
      2,
    )}\n`,
  );
  console.log(`已写出 ${out}`);
}
