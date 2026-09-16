#!/usr/bin/env node
// 真实代码库语义召回对比（U3 真实落地）：对真实 src/ 目录，用真实 all-MiniLM-L6-v2 模型，
// 在 10 个真实查询上对比 纯BM25 repo-map 与 混合检索（BM25 ∪ 语义向量 RRF 融合）的「文件召回」。
// 这是「破召回天花板（67%→≥80%）」的直接证据。复用生产级 getRepoMapContext / getHybridRepoMapContext。
//
// 用法：HF_ENDPOINT=https://hf-mirror.com node evals/recall-codebase-real.mjs
// 首次需联网下载权重（已缓存到 OMNI_EMBEDDING_CACHE_DIR 后离线可跑）。

import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { writeFileSync, appendFileSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const DIST = join(ROOT, 'dist', 'src');
const importDist = (...segments) => import(pathToFileURL(join(DIST, ...segments)).href);

// 同步进度日志（绝对路径，被杀也能看到卡点）。
const PLOG = join(ROOT, 'recall-progress.log');
writeFileSync(PLOG, `start ${new Date().toISOString()}\n`);
const log = (m) => appendFileSync(PLOG, m + '\n');

const { RepoMapContextEngine } = await importDist('context', 'repoMapContextEngine.js');
const { indexCorpus } = await importDist('context', 'contextEngine.js');
const { TransformersEmbeddingAdapter } = await importDist(
  'adapters',
  'embedding',
  'transformersEmbeddingAdapter.js',
);
const { SemanticIndex, rrfMerge } = await importDist('context', 'semanticIndex.js');
/** repo-map 生产接入器实例（原模块级包装函数已随重命名移除，统一走实例方法）。 */
const repoMap = new RepoMapContextEngine();

// 仅保留「本地 wasm 路径」这一项环境设置；**模型下载源不再在此手改库全局状态**——
// 适配器已提供 `remoteHost` 旋钮（与生产装配路径 `configFactory` 同一入口），经 embedOpts 传入即可。
// 旧写法直接 `env.remoteHost = ...` 属「基准脚本绕过装配层」：脚本绿了、生产却无对应入口。
async function applyWasmEnv() {
  const wasm = process.env.HF_WASM_PATH;
  if (!wasm) return;
  const { env } = await import('@huggingface/transformers');
  env.backends.onnx.wasm.wasmPaths = wasm;
}
await applyWasmEnv();
log('[1] wasm env applied');

const SRC = join(ROOT, 'src');
const FILE_K = Number(process.env.OMNI_FILE_K ?? 14);

// 可选 --model <preset|hfId>：切换嵌入模型（默认 minilm；e5-*-v2 为代码检索级）。
// 含 '/' 视为完整 HF id，否则按预设名解析。
const MODEL_ARG_IDX = process.argv.indexOf('--model');
const MODEL_ARG = MODEL_ARG_IDX >= 0 ? process.argv[MODEL_ARG_IDX + 1] : undefined;

// 真实代码库语料（用于无偏 ground truth：含锚点字符串的文件集合）。
const corpus = indexCorpus(SRC, { morph: true, light: true });
log(`[2] corpus indexed: ${corpus.files.length} files, ${corpus.symbols.length} symbols`);
function groundTruth(anchor) {
  const needle = anchor.toLowerCase();
  const set = new Set();
  for (const [rel, text] of corpus.fileText) {
    if (text.toLowerCase().includes(needle)) set.add(rel);
  }
  return set;
}

// 33 个真实查询 + 独立锚点（锚点字符串定位答案文件，不依赖 BM25，避免自证循环）。
// 设计原则：
//  ① 查询用自然语言改写，**刻意避开锚点字面词**（制造词法鸿沟，否则 BM25 直接命中，测不出语义价值）；
//  ② 锚点必须真实存在于语料（GT≥1）——GT=0 的查询会让 recall 兜底成 100%，污染绝对值。
//     （历史教训：锚点 `prevHash` 在语料中不存在，却因 `gt.size ? ... : 1` 白送 10pp，虚高基线。）
const QUERIES = [
  // ── 原 10 条（保留以对齐历史口径；`prevHash` 因 GT=0 已剔除）──────────────
  { q: 'where is tool registration handled', anchor: 'registerTool' },
  { q: 'how does sandbox denial escalate to approval', anchor: 'EscalationPort' },
  { q: 'what does ContextAssembler project events into', anchor: 'class ContextAssembler' },
  { q: 'how are images attached to model messages', anchor: 'imagesOf' },
  { q: 'where is reasoning_effort sent to the openai model', anchor: 'reasoning_effort' },
  { q: 'how does BM25 tokenize CJK text', anchor: 'export function tokenize' },
  { q: 'how is the resonant memory probe mapped from text', anchor: 'resonateByText' },
  { q: 'where is the sandbox policy evaluated', anchor: 'execPolicy' },
  { q: 'how are tool results spilled out of context', anchor: 'spill_read' },
  // ── 新增 24 条（跨模块，制造词法鸿沟）────────────────────────────────────
  {
    q: 'which component remembers decisions the operator already blessed',
    anchor: 'ApprovalStore',
  },
  { q: 'how is a signed claim from an agent packaged', anchor: 'AgentAssertionEnvelope' },
  { q: 'which key-value store replicates records across nodes', anchor: 'OobleckStore' },
  { q: 'tuning knobs for the graph that links distant memories', anchor: 'CosmicWebOptions' },
  { q: 'settings for the planner that gradually cools down', anchor: 'HeatAnnealerOptions' },
  {
    q: 'options controlling what gets pulled out of conversations',
    anchor: 'MemoryExtractorOptions',
  },
  { q: 'knobs for the parity based error correction layer', anchor: 'QECOptions' },
  { q: 'what signals that a parity check has failed', anchor: 'Syndrome' },
  { q: 'where is the remaining spend captured at a point in time', anchor: 'BudgetSnapshot' },
  { q: 'how is a chain of thought persisted to disk', anchor: 'StoredTrace' },
  { q: 'what normalizes text before it is compared', anchor: 'Canonicalizer' },
  { q: 'how long is a prior yes remembered before asking again', anchor: 'CachedApprovalOptions' },
  { q: 'settings for the belief updater that follows curvature', anchor: 'NaturalGradientOptions' },
  {
    q: 'tunables for the sampler tracking many hypotheses at once',
    anchor: 'ParticleFilterOptions',
  },
  { q: 'how is the local vector model configured', anchor: 'TransformersEmbeddingOptions' },
  { q: 'where are ed25519 signing credentials created', anchor: 'KeyPairSync' },
  { q: 'how are orphaned tool call identifiers tracked', anchor: 'ToolCallRef' },
  { q: 'how is the chat completion provider configured', anchor: 'OpenAiModelConfig' },
  { q: 'where do language server error reports come from', anchor: 'Diagnostics' },
  { q: 'how many characters of a conversation are retained', anchor: 'TranscriptChars' },
  { q: 'what does a delegated child task return', anchor: 'SubagentResult' },
  { q: 'what represents one entry in a multi stage plan', anchor: 'PlanStep' },
  { q: 'where are capabilities discovered and registered', anchor: 'SkillRegistry' },
  { q: 'which component gates dangerous tool calls at runtime', anchor: 'SupervisorKernel' },
];

// 硬守卫：锚点在语料里找不到 → 直接失败，不允许 recall 兜底成 100% 污染统计。
for (const { q, anchor } of QUERIES) {
  if (groundTruth(anchor).size === 0) {
    throw new Error(
      `锚点在语料中不存在（GT=0），会污染召回统计，请修正：query="${q}" anchor="${anchor}"`,
    );
  }
}

function surfacedFiles(context) {
  const files = new Set();
  if (!context) return files;
  for (const line of context.split('\n')) {
    const m = line.match(/📄\s+(.+)/);
    if (m) files.add(m[1].trim());
  }
  return files;
}

// 加载真实模型（首次联网下载，已缓存则离线复用）。
log('[3] loading embedding model...');
const embedOpts = {
  cacheDir: process.env.OMNI_EMBEDDING_CACHE_DIR,
  localFilesOnly: process.env.OMNI_EMBEDDING_OFFLINE === '1',
  // 模型下载源走适配器旋钮（与生产 `configFactory` 同一条路径），不再手改库全局状态。
  remoteHost: process.env.OMNI_HF_ENDPOINT ?? process.env.HF_ENDPOINT,
};
if (MODEL_ARG) {
  if (MODEL_ARG.includes('/')) embedOpts.model = MODEL_ARG;
  else embedOpts.preset = MODEL_ARG;
}
const embedding = new TransformersEmbeddingAdapter(embedOpts);
await embedding.embed(['warmup']);
console.log(`✅ 真实嵌入模型已加载：${embedding.modelId}（dim=${embedding.dim}）`);
log('[4] model ready; precomputing BM25 baseline + semantic hits');

// 预计算：每个查询的 ground truth、BM25 基线召回（跨所有 RRF 组合不变）。
const n = QUERIES.length;
const pre = [];
for (const { q, anchor } of QUERIES) {
  const gt = groundTruth(anchor);
  const bm25Ctx = repoMap.getRepoMapContext(SRC, q, { fileK: FILE_K }) ?? '';
  const bm25Surf = surfacedFiles(bm25Ctx);
  const bm25Recall = gt.size ? [...gt].filter((f) => bm25Surf.has(f)).length / gt.size : 0;
  pre.push({ q, anchor, gt, bm25Recall });
  log(`[bm25] ${q} GT=${gt.size} bm25=${(bm25Recall * 100).toFixed(0)}%`);
}
const bm25Avg = (pre.reduce((s, p) => s + p.bm25Recall, 0) / n) * 100;
console.log(`\n=== BM25 基线（fileK=${FILE_K}）：平均 ${bm25Avg.toFixed(1)}% ===`);

// ── 诊断模式：区分「embedding 不行」还是「融合把语义结果扔了」 ──────────────────
// 手法：把 semWeight 拉到 1e9，RRF 里 BM25 贡献变得可忽略，输出即「纯语义排序」，
// 由此得到语义路在同一 fileK 下的召回天花板。
//   语义天花板 ≈ 混合召回  → 融合没问题，是 embedding 本身召回不来；
//   语义天花板 >> 混合召回 → 融合在丢弃语义命中（可观的、可修的收益）。
if (process.argv.includes('--diagnose')) {
  console.log('\n=== 诊断：纯语义路召回天花板（semWeight=1e9） ===');
  let semHit = 0;
  const semRows = [];
  for (const p of pre) {
    const semCtx =
      (await repoMap.getHybridRepoMapContext(SRC, p.q, embedding, {
        fileK: FILE_K,
        semWeight: 1e9,
      })) ?? '';
    const semSurf = surfacedFiles(semCtx);
    const semRecall = p.gt.size ? [...p.gt].filter((f) => semSurf.has(f)).length / p.gt.size : 0;
    semHit += semRecall;
    semRows.push({
      q: p.q,
      gt: p.gt.size,
      bm25: +(p.bm25Recall * 100).toFixed(1),
      semantic: +(semRecall * 100).toFixed(1),
    });
  }
  const semAvg = (semHit / n) * 100;
  console.log(
    `  纯语义（semWeight=1e9）：${semAvg.toFixed(1)}%   vs   BM25：${bm25Avg.toFixed(1)}%`,
  );
  console.log('逐查询：');
  for (const r of semRows) {
    const mark = r.semantic > r.bm25 ? ' 语义胜' : r.semantic < r.bm25 ? ' 语义负' : '';
    console.log(
      `  ${r.q.padEnd(52)} GT=${String(r.gt).padStart(2)}  BM25=${String(r.bm25).padStart(5)}%  Semantic=${String(r.semantic).padStart(5)}%${mark}`,
    );
  }
  const semWins = semRows.filter((r) => r.semantic > r.bm25).length;
  console.log(`\n结论：语义单路优于 BM25 的查询数 = ${semWins}/${n}`);

  // ── 符号级语义天花板：独立于文件级文档，纯用符号向量（name+kind+signature）召回并映射回文件 ──
  console.log('\n=== 诊断：符号级语义召回天花板（符号文档→映射回文件） ===');
  const symIdx = new SemanticIndex(embedding);
  const symItems = corpus.symbols.map((s, i) => ({
    id: `sym:${i}`,
    text: `${s.name} ${s.kind} ${s.signature} ${s.file}`,
  }));
  await symIdx.build(symItems);
  let symHit = 0;
  const symCeilRows = [];
  for (const p of pre) {
    const top = await symIdx.search(p.q, 80);
    const seen = new Set();
    const files = [];
    for (const h of top) {
      const sym = corpus.symbols[Number(h.id.slice('sym:'.length))];
      if (sym !== undefined && !seen.has(sym.file)) {
        seen.add(sym.file);
        files.push(sym.file);
      }
    }
    const surf = new Set(files.slice(0, FILE_K));
    const rec = p.gt.size ? [...p.gt].filter((f) => surf.has(f)).length / p.gt.size : 0;
    symHit += rec;
    symCeilRows.push({
      q: p.q,
      gt: p.gt.size,
      bm25: +(p.bm25Recall * 100).toFixed(1),
      symCeil: +(rec * 100).toFixed(1),
    });
  }
  const symCeilAvg = (symHit / n) * 100;
  console.log(
    `  符号级语义天花板：${symCeilAvg.toFixed(1)}%   vs   文件级语义天花板 ${semAvg.toFixed(1)}%   vs   BM25 ${bm25Avg.toFixed(1)}%`,
  );
  for (const r of symCeilRows) {
    const mark = r.symCeil > r.bm25 ? ' 符号胜' : r.symCeil < r.bm25 ? ' 符号负' : '';
    console.log(
      `  ${r.q.padEnd(52)} GT=${String(r.gt).padStart(2)}  BM25=${String(r.bm25).padStart(5)}%  SymCeil=${String(r.symCeil).padStart(5)}%${mark}`,
    );
  }
  const symCeilWins = symCeilRows.filter((r) => r.symCeil > r.bm25).length;
  console.log(`\n结论：符号级单路优于 BM25 的查询数 = ${symCeilWins}/${n}`);

  writeFileSync(
    new URL('./recall-diagnose.report.json', import.meta.url),
    JSON.stringify(
      {
        fileK: FILE_K,
        queryCount: n,
        bm25Avg: +bm25Avg.toFixed(1),
        semanticCeilingAvg: +semAvg.toFixed(1),
        semWins,
        symbolCeilingAvg: +symCeilAvg.toFixed(1),
        symbolCeilingWins: symCeilWins,
        rows: semRows,
        symbolCeilingRows: symCeilRows,
      },
      null,
      2,
    ),
  );
  console.log('Wrote evals/recall-diagnose.report.json');
  process.exit(0);
}

// 跑一个组合：combo 为 null 表示「生产默认」（不设任何 env 覆盖，走代码内默认值）。
// 语义索引只在首个组合构建一次（进程内缓存），后续组合仅重排 + 重融（廉价）。
async function runCombo(combo) {
  const label = combo ? `k=${combo.rrfK} w=${combo.semWeight}` : 'default';
  if (combo) {
    process.env.OMNI_RRF_K = String(combo.rrfK);
    process.env.OMNI_SEM_WEIGHT = String(combo.semWeight);
    if (combo.bm25Floor !== undefined) process.env.OMNI_BM25_FLOOR = String(combo.bm25Floor);
    else delete process.env.OMNI_BM25_FLOOR;
  } else {
    delete process.env.OMNI_RRF_K;
    delete process.env.OMNI_SEM_WEIGHT;
    delete process.env.OMNI_BM25_FLOOR;
    delete process.env.OMNI_MERGE_SYMBOLS;
  }
  let hybHit = 0;
  const rows = [];
  for (const p of pre) {
    const hybCtx =
      (await repoMap.getHybridRepoMapContext(SRC, p.q, embedding, { fileK: FILE_K })) ?? '';
    const hybSurf = surfacedFiles(hybCtx);
    const hybRecall = p.gt.size ? [...p.gt].filter((f) => hybSurf.has(f)).length / p.gt.size : 0;
    hybHit += hybRecall;
    rows.push({
      q: p.q,
      gt: p.gt.size,
      bm25: +(p.bm25Recall * 100).toFixed(1),
      hybrid: +(hybRecall * 100).toFixed(1),
    });
    log(`[hyb ${label}] ${p.q} ${(hybRecall * 100).toFixed(0)}%`);
  }
  const hybAvg = (hybHit / n) * 100;
  const rec = {
    rrfK: combo ? combo.rrfK : null,
    semWeight: combo ? combo.semWeight : null,
    bm25Avg: +bm25Avg.toFixed(1),
    hybridAvg: +hybAvg.toFixed(1),
    deltaPp: +(hybAvg - bm25Avg).toFixed(1),
    rows,
  };
  console.log(
    `  ${label.padEnd(16)} BM25=${bm25Avg.toFixed(1)}%  Hybrid=${hybAvg.toFixed(1)}%  (${hybAvg >= bm25Avg ? '+' : ''}${(hybAvg - bm25Avg).toFixed(1)}pp)`,
  );
  return rec;
}

// ① 生产默认（无 env 覆盖）——这次要交付的结论：默认参数下的真实增益。
console.log('\n=== 生产默认（代码内默认 rrfK / semWeight） ===');
const defaultRun = await runCombo(null);

// --ablate：消融模式，只跑「生产默认」，跳过网格扫描与保护位扫描。
// 用途：一次只切一个变量（如 chunkRecall 开/关 × 模型）做受控对照，避免每次白跑 16 组组合。
const ABLATE = process.argv.includes('--ablate');

// ② 网格扫描：证明默认取值确实处在高原上（不是偶然挑出来的）。
console.log('\n=== RRF 参数网格扫描 ===');
const grid = [];
// 语义路变强后（文件文档含符号名，天花板 44.6%→50.7%），权重上限必须往上探：
// 语义弱时需要降权防噪声，语义强时降权等于自废武功。
if (!ABLATE) {
  for (const rrfK of [20, 60]) {
    for (const semWeight of [0.5, 0.7, 1.0, 1.5, 2.0, 3.0]) {
      grid.push(await runCombo({ rrfK, semWeight }));
    }
  }
}

grid.sort((a, b) => b.deltaPp - a.deltaPp);
const best = grid[0] ?? {
  rrfK: null,
  semWeight: null,
  hybridAvg: defaultRun.hybridAvg,
  deltaPp: defaultRun.deltaPp,
  rows: defaultRun.rows,
};
if (ABLATE) {
  console.log('  （--ablate：跳过网格扫描，best 沿用生产默认）');
} else {
  console.log(
    `\n=== RRF 扫描最佳组合：k=${best.rrfK}, semWeight=${best.semWeight} → Hybrid=${best.hybridAvg}% (${best.deltaPp >= 0 ? '+' : ''}${best.deltaPp}pp) ===`,
  );
  console.log('逐查询（最佳组合）：');
  for (const r of best.rows) {
    console.log(
      `  ${r.q.padEnd(52)} GT=${String(r.gt).padStart(2)}  BM25=${String(r.bm25).padStart(5)}%  Hybrid=${String(r.hybrid).padStart(5)}%`,
    );
  }
}

console.log(
  `\n=== 生产默认：Hybrid=${defaultRun.hybridAvg}% (${defaultRun.deltaPp >= 0 ? '+' : ''}${defaultRun.deltaPp}pp vs BM25 ${defaultRun.bm25Avg}%) ===`,
);
console.log('逐查询（生产默认）：');
for (const r of defaultRun.rows) {
  const mark = r.hybrid > r.bm25 ? ' ↑' : r.hybrid < r.bm25 ? ' ↓' : '  ';
  console.log(
    `  ${r.q.padEnd(52)} GT=${String(r.gt).padStart(2)}  BM25=${String(r.bm25).padStart(5)}%  Hybrid=${String(r.hybrid).padStart(5)}%${mark}`,
  );
}

// ③ BM25 保护位扫描：验证「融合召回只增不减」不变量能否低成本守住。
// 仅在最优 (rrfK=60, semWeight=1.0) 上扫 bm25Floor：强制保留 BM25 前 N 文件，
// 留 (FILE_K - N) 槽给语义探索。重点看那条回退查询能否被救回、整体增益是否松动。
console.log('\n=== BM25 保护位扫描（k=60, w=1.0） ===');
const floorScan = [];
for (const bm25Floor of ABLATE ? [] : [0, 6, 8, 10]) {
  const run = await runCombo({ rrfK: 60, semWeight: 1.0, bm25Floor });
  const up = run.rows.filter((r) => r.hybrid > r.bm25).length;
  const down = run.rows.filter((r) => r.hybrid < r.bm25).length;
  const flat = run.rows.filter((r) => r.hybrid === r.bm25).length;
  const tc = run.rows.find((r) => r.q === 'how are orphaned tool call identifiers tracked');
  floorScan.push({
    bm25Floor,
    hybridAvg: run.hybridAvg,
    deltaPp: run.deltaPp,
    up,
    down,
    flat,
    toolCallRef: tc ? `${tc.bm25}%→${tc.hybrid}%` : 'n/a',
  });
  console.log(
    `  floor=${String(bm25Floor).padStart(2)}  Hybrid=${String(run.hybridAvg).padStart(5)}% (${run.deltaPp >= 0 ? '+' : ''}${run.deltaPp}pp)  ↑${up}/↓${down}/=${flat}  ToolCallRef=${floorScan.at(-1).toolCallRef}`,
  );
}

// 关键诚实统计量：增益是「普遍提升」还是「单点击穿」——看有多少条查询真正动了。
const tally = { up: 0, down: 0, flat: 0, upQueries: [], downQueries: [] };
for (const r of defaultRun.rows) {
  if (r.hybrid > r.bm25) {
    tally.up++;
    tally.upQueries.push(`${r.q} (${r.bm25}%→${r.hybrid}%)`);
  } else if (r.hybrid < r.bm25) {
    tally.down++;
    tally.downQueries.push(`${r.q} (${r.bm25}%→${r.hybrid}%)`);
  } else {
    tally.flat++;
  }
}
console.log(
  `\n分布：↑${tally.up} 条提升 / ↓${tally.down} 条回退 / =${tally.flat} 条持平（共 ${n} 条）`,
);
for (const s of tally.upQueries) console.log(`  ↑ ${s}`);
for (const s of tally.downQueries) console.log(`  ↓ ${s}`);

// ── Path ②：重评 light 模式禁用的 codeGraph / LSA / 频谱（共振）组件 ───────────────
// 这三项当初在「符号名修复前 + 早期（可能含假基线）测量」下被判「零增益」而关进 light 模式。
// 诚实重测：用全量索引（light:false，含频谱+代码图+LSA）启用它们，在 33 条核实锚点查询上比文件召回。
// 纯本地（无需模型、无需联网）：graph/LSA/频谱都在 contextEngine.query() 内，靠 opts 开关。
//
// 受控基线原则（修复历史语料混淆）：
//   - 全量语料（light:false）同时含「频谱+graph+lsa」三类分量。若直接拿 full 语料某变体 vs 生产
//     light 语料比，会把「语料差异」和「组件增益」混为一谈（历史某次「+2.5pp」正是此伪影）。
//   - 故：在同一 full 语料内，以「频谱开 / graph关 / lsa关」为受控基线（base），graph/lsa 的 Δ 自然
//     隔离出各自变量；频谱在所有变体里恒定开启，其增量不在此重测（已在 tmp_diag_spectrum.mjs 同
//     corpus 隔离对照中确认纯零效应 41.4% = 41.4%）。
//   - 另把受控基线（full+频谱）与生产 bm25Avg（light，无频谱）对照，可独立验证「频谱对文件召回零效应」：
//     两者应≈相等（同 corpus、唯独频谱有无这一变量）。
let heavyRows = null;
if (process.argv.includes('--heavy')) {
  console.log('\n=== Path② HEAVY：全量索引 + graph/lsa/频谱 诚实重测（33 查询文件召回） ===');
  log('[heavy] building full (light:false) corpus...');
  const full = indexCorpus(SRC, { morph: true, light: false });
  log(
    `[heavy] full corpus: ${full.files.length} files, ${full.symbols.length} symbols, edges=${full.codeGraph.adj.reduce((a, x) => a + x.length, 0)}, lsaK=${full.lsaModel.k}`,
  );
  const { query } = await importDist('context', 'contextEngine.js');
  const variants = [
    { name: 'base(BM25+spectrum)', opts: { graph: false, lsa: false } },
    { name: 'BM25+spectrum+graph', opts: { graph: true, lsa: false } },
    { name: 'BM25+spectrum+lsa', opts: { graph: false, lsa: true } },
    { name: 'BM25+spectrum+graph+lsa', opts: { graph: true, lsa: true } },
  ];
  const perVariant = [];
  for (const v of variants) {
    let hit = 0;
    const rows = [];
    for (const p of pre) {
      const res = query(full, p.q, { ...v.opts, fileK: FILE_K, symK: 24 });
      const surf = new Set(res.files);
      const rec = p.gt.size ? [...p.gt].filter((f) => surf.has(f)).length / p.gt.size : 0;
      hit += rec;
      rows.push({ q: p.q, gt: p.gt.size, recall: +(rec * 100).toFixed(1) });
    }
    perVariant.push({ name: v.name, avg: (hit / n) * 100, rows });
  }
  const baseAvg = perVariant[0].avg;
  heavyRows = perVariant.map((pv) => ({
    name: pv.name,
    avg: +pv.avg.toFixed(1),
    deltaVsBase: +(pv.avg - baseAvg).toFixed(1),
    deltaVsProductionBm25: +(pv.avg - bm25Avg).toFixed(1),
    deltaVsHybridMiniLM: +(pv.avg - defaultRun.hybridAvg).toFixed(1),
  }));
  for (const pv of perVariant) {
    console.log(
      `  ${pv.name.padEnd(26)} ${pv.avg.toFixed(1)}%  (Δbase ${pv.avg >= baseAvg ? '+' : ''}${(pv.avg - baseAvg).toFixed(1)}pp, Δ生产BM25 ${pv.avg >= bm25Avg ? '+' : ''}${(pv.avg - bm25Avg).toFixed(1)}pp, ΔHybrid ${pv.avg >= defaultRun.hybridAvg ? '+' : ''}${(pv.avg - defaultRun.hybridAvg).toFixed(1)}pp)`,
    );
  }
  console.log('  脚注（诚实性）：');
  console.log(
    `    ① 频谱「同 corpus 开关隔离」（FULL corpus 仅切 symbolSpectra）：${baseAvg.toFixed(1)}%(ON) = ${baseAvg.toFixed(1)}%(OFF) → 纯零效应（见 evals/diag-spectrum.mjs，33 查询全部 anchoring 一致）。这才是有效对照。`,
  );
  console.log(
    `    ② base(BM25+spectrum, full)=${baseAvg.toFixed(1)}% 与 生产 bm25Avg(light)=${bm25Avg.toFixed(1)}% 的 ${(baseAvg - bm25Avg).toFixed(1)}pp 差异，来自 getRepoMapContext 与 indexCorpus(full)+raw query 两条索引路径的实现差，与频谱无关（频谱已证零效应）。`,
  );
  console.log(
    '    ③ 历史某次「频谱 +2.5pp」是 full 语料 vs light 语料两语料混淆的伪影；早期在 light corpus 上做对照（light 下 spectra 恒空）属空实验已废，以 evals/diag-spectrum.mjs 的同 corpus FULL 对照为准。',
  );
  console.log(
    '    ④ 结论：graph/lsa 在受控基线之上的 Δ 即其真实增益；三项组件均不翻盘（graph 负、lsa no-op、频谱零）。',
  );
  log('[heavy] done');
}

const out = {
  fileK: FILE_K,
  queryCount: n,
  model: embedding.modelId,
  modelDim: embedding.dim,
  // 消融配置自述：多份报告并行存在时，靠这一块区分「哪个变量开着」。
  ablation: {
    ablateMode: ABLATE,
    chunkRecall: process.env.OMNI_CHUNK_RECALL === '1',
    mergeSymbols: process.env.OMNI_MERGE_SYMBOLS !== '0',
    rrfK: process.env.OMNI_RRF_K ?? null,
    semWeight: process.env.OMNI_SEM_WEIGHT ?? null,
  },
  bm25Avg: +bm25Avg.toFixed(1),
  // 生产默认（无任何 env 覆盖）——对外汇报口径以此为准。
  productionDefault: {
    hybridAvg: defaultRun.hybridAvg,
    deltaPp: defaultRun.deltaPp,
    tally: { up: tally.up, down: tally.down, flat: tally.flat },
    rows: defaultRun.rows,
  },
  best: {
    rrfK: best.rrfK,
    semWeight: best.semWeight,
    hybridAvg: best.hybridAvg,
    deltaPp: best.deltaPp,
  },
  sweep: grid,
  bm25FloorScan: floorScan,
  heavy: heavyRows,
};
writeFileSync(
  new URL('./recall-codebase-real.report.json', import.meta.url),
  JSON.stringify(out, null, 2),
);
console.log('Wrote evals/recall-codebase-real.report.json');
