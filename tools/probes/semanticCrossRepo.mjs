#!/usr/bin/env node
/**
 * 跨仓库语义混合检索复测探针（2026-10-05；复测"外部仓库 pooled 0.0pp"历史结论）。
 *
 * ## 回答什么问题
 *
 * 语义混合检索（当前实现：符号名表征 + 可选 chunk）的增益**是否跨语料成立**？
 * 历史结论（2026-10-01 前的旧测量）：跨 5 个外部 Python 仓库 pooled **0.0pp** ⇒ 不外推。
 * 但该测量早于两处实现变更（语义索引改用「符号名才是文件最强表征」的文档构造 + chunk 召回），
 * 结论需要用**当前实现**重新裁决。查询集复用幸存的 `tests/fixtures/recallQueriesCrossRepo.ts`
 * （5 仓 × 12 条，锚点/稀有性/对抗性/路径词协议齐全）。
 *
 * ## 口径
 *
 * - 每仓两镜头：纯 BM25（静态路径）vs 语义混合（渲染文本解析，agent 真实所见）；
 * - GT = 锚点字面量在文件正文（与仓内探针同口径）；
 * - 汇总 = pooled 逐查询差的两关统计（配对 bootstrap 95% CI + repeated 2-fold，固定种子）。
 *
 * ## 前置
 *
 * - 需要编译产物：先 `npm run build`；
 * - **需要外部语料**（gitignored，不入库）：5 个外部仓库浅克隆到 `eval-data/repos/**`——
 *   本探针启动即检查，缺失时**打印可执行的克隆命令**并以退出码 2 终止（绝不静默空跑）；
 * - **需要网络一次**（嵌入权重 ≈23MB）：境外不通设 `OMNI_HF_ENDPOINT` 指向镜像源。
 *
 * ## 用法
 *
 * ```bash
 * node tools/probes/semanticCrossRepo.mjs [--fileK=20] [--json=out.json]
 * ```
 *
 * ## 诚实边界
 *
 * - 查询集由模型按公开文档知识撰写、未经第二方独立复核（fixture 头部原注记继续有效）；
 * - 外部仓库为 Python 代码（与本仓 TS 异构）——符号抽取对 Python 的覆盖弱于 TS，
 *   语义路吃到的是「文本 + 路径 + 少量符号」表征，这是异构场景的**真实难度**而非仪器缺陷；
 * - 探针不做任何默认值裁决：跨仓结论只影响 README 诚实边界与文档口径的写法。
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { probeArgs } from './_args.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const importDist = (...segments) => import(pathToFileURL(join(ROOT, 'dist', ...segments)).href);

// 参数解析排在 dist 动态 import **之前**（理由见 `_args.mjs` 头注释）。
const a = probeArgs({ values: { fileK: '20', json: '' } });
const FILE_K = Number(a.fileK);
const JSON_OUT = String(a.json);
if (!Number.isInteger(FILE_K) || FILE_K <= 0) {
  console.error('✗ --fileK 必须是正整数（例：--fileK=20）');
  process.exit(2);
}

let ContextEngine;
let RepoMapContextEngine;
let TransformersEmbeddingAdapter;
let DiskCachedEmbeddingAdapter;
let CROSS_REPO_CORPORA;
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
  ({ CROSS_REPO_CORPORA } = await import(
    pathToFileURL(join(ROOT, 'dist', 'tests', 'fixtures', 'recallQueriesCrossRepo.js')).href
  ));
} catch (error) {
  console.error('✗ 缺少编译产物。请先运行 `npm run build`。');
  process.exit(2);
}

const EVAL_DATA = join(ROOT, 'eval-data');
const VEC_CACHE =
  process.env.OMNI_EMBEDDING_CACHE_DIR ?? join(ROOT, '.cache', 'omni-embed-vectors');
mkdirSync(VEC_CACHE, { recursive: true });

// 语料就位检查：缺哪个仓就打印哪条克隆命令（fail-visible，绝不空跑）。
const missing = [];
for (const c of CROSS_REPO_CORPORA) {
  const dir = join(ROOT, c.root);
  if (!existsSync(dir)) {
    missing.push(c.repo);
  }
}
if (missing.length > 0) {
  console.error(
    '✗ 外部语料缺失（eval-data/ 不入库，需本机就位）。逐仓执行：\n' +
      missing
        .map(
          (r) =>
            `  git clone --depth 1 https://ghproxy.net/https://github.com/${r} eval-data/repos/${r.replaceAll('/', '__')}`,
        )
        .join('\n') +
      '\n  （flask / requests 需把包目录再复制为 src/<pkg>：见 fixture root 字段）',
  );
  process.exit(2);
}

const inner = new TransformersEmbeddingAdapter({
  preset: 'minilm',
  cacheDir: join(VEC_CACHE, 'models'),
  remoteHost: TransformersEmbeddingAdapter.resolveRemoteHostFromEnv(),
  localFilesOnly: process.env.OMNI_EMBEDDING_OFFLINE === '1',
});
const embedding = new DiskCachedEmbeddingAdapter({ inner, cacheDir: join(VEC_CACHE, 'vectors') });
// 开跑前嵌入自检（与 semanticHybridRecall 同款：不通当场报真错，不发水分数据）。
try {
  const warm = await embedding.embed(['probe self-check'], { role: 'query' });
  if (warm[0]?.length !== inner.dim) throw new Error(`维度异常 ${String(warm[0]?.length)}`);
  console.log(`自检通过：dim=${String(inner.dim)} 模型=${inner.modelId}\n`);
} catch (error) {
  console.error(`✗ 嵌入自检失败：${error instanceof Error ? error.message : String(error)}`);
  process.exit(3);
}

const engine = new RepoMapContextEngine();
const pooled = { base: [], hybrid: [] };
const perCorpus = [];

for (const c of CROSS_REPO_CORPORA) {
  const absRoot = join(ROOT, c.root);
  const corpus = ContextEngine.indexCorpus(absRoot, { morph: true, light: true });
  const rels = [...corpus.fileText.keys()];
  const gtOf = (anchor) => {
    const needle = anchor.toLowerCase();
    const out = new Set();
    for (const [rel, text] of corpus.fileText) {
      if (text.toLowerCase().includes(needle)) out.add(rel);
    }
    return out;
  };
  const cases = [];
  for (const entry of c.queries) {
    const gt = gtOf(entry.anchor);
    if (gt.size === 0) continue; // 锚点失效（上游代码漂移）：如实跳过并计数
    cases.push({ q: entry.q, gt, anchor: entry.anchor });
  }
  const skipped = c.queries.length - cases.length;
  const base = cases.map(({ q, gt }) => {
    const res = ContextEngine.query(corpus, q, { fileK: FILE_K });
    return res.files.some((f) => gt.has(f)) ? 1 : 0;
  });
  const hybrid = [];
  for (const { q, gt } of cases) {
    const text = await engine.getHybridRepoMapContext(absRoot, q, embedding, { fileK: FILE_K });
    let hit = 0;
    if (text !== null) {
      for (const rel of rels) {
        if (text.includes(rel) && gt.has(rel)) {
          hit = 1;
          break;
        }
      }
    }
    hybrid.push(hit);
  }
  pooled.base.push(...base);
  pooled.hybrid.push(...hybrid);
  const rate = (v) => `${((100 * v.reduce((a, b) => a + b, 0)) / v.length).toFixed(1)}%`;
  perCorpus.push({
    repo: c.repo,
    queries: cases.length,
    skippedAnchors: skipped,
    baseRate: +((100 * base.reduce((a, b) => a + b, 0)) / base.length).toFixed(1),
    hybridRate: +((100 * hybrid.reduce((a, b) => a + b, 0)) / hybrid.length).toFixed(1),
  });
  console.log(
    `  ${c.repo.padEnd(22)} n=${String(cases.length)}（锚点失效跳过 ${String(skipped)}）  BM25 ${rate(base)}  →  混合 ${rate(hybrid)}`,
  );
}

const n = pooled.base.length;
const delta = pooled.hybrid.map((v, i) => v - pooled.base[i]);
const mean = (100 * delta.reduce((a, b) => a + b, 0)) / n;
let seed = 0x5eed1e;
const rnd = () => (seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff) / 0x7fffffff;
const boot = [];
for (let r = 0; r < 4000; r += 1) {
  let s = 0;
  for (let i = 0; i < n; i += 1) s += delta[Math.floor(rnd() * n)];
  boot.push((s / n) * 100);
}
boot.sort((a, b) => a - b);
const ci = [boot[100].toFixed(2), boot[3900].toFixed(2)];
let seed2 = 0x9e3779b9;
const rnd2 = () => (seed2 = (Math.imul(seed2, 1103515245) + 12345) & 0x7fffffff) / 0x7fffffff;
let neg = 0;
const total = 40;
for (let r = 0; r < 20; r += 1) {
  const ix = delta.map((_, i) => i);
  for (let i = ix.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rnd2() * (i + 1));
    [ix[i], ix[j]] = [ix[j], ix[i]];
  }
  const half = Math.floor(n / 2);
  const m1 = (100 * ix.slice(0, half).reduce((a, i) => a + delta[i], 0)) / half;
  const m2 = (100 * ix.slice(half).reduce((a, i) => a + delta[i], 0)) / (n - half);
  if (m1 < -1e-9) neg += 1;
  if (m2 < -1e-9) neg += 1;
}
const up = delta.filter((x) => x > 0).length;
const down = delta.filter((x) => x < 0).length;
console.log(
  `\npooled（n=${String(n)}）：BM25 ${((100 * pooled.base.reduce((a, b) => a + b, 0)) / n).toFixed(1)}% → 混合 ${((100 * pooled.hybrid.reduce((a, b) => a + b, 0)) / n).toFixed(1)}% ｜ Δ=${mean.toFixed(1)}pp CI95[${String(ci[0])}, ${String(ci[1])}]（↑${String(up)}/↓${String(down)}）折负 ${String(neg)}/${String(total)}`,
);
console.log(
  ci[0] > 0 && neg === 0
    ? '判定：**过两关** ⇒ 「跨仓 0.0pp」旧结论被当前实现推翻（按本探针口径）'
    : `判定：未过两关 ⇒ 「跨仓不外推」的诚实边界**维持**（本测量与旧结论同向或不可判定）`,
);

if (JSON_OUT !== '') {
  const out = JSON_OUT;
  writeFileSync(
    out,
    `${JSON.stringify(
      {
        probe: 'semanticCrossRepo',
        fileK: FILE_K,
        pooled: { n, mean: +mean.toFixed(2), ci, up, down, foldsNeg: neg, foldsTotal: total },
        perCorpus,
      },
      null,
      2,
    )}\n`,
  );
  console.log(`已写出 ${out}`);
}
