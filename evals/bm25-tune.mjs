#!/usr/bin/env node
// BM25 打分参数（k1/b）调参扫描 —— 检索侧「第一杠杆」的诚实测量（零依赖、无网络）。
//
// 动机（2026 行业共识）：SE 任务的 RAG 里 **retriever 选择/调参的收益大于 generator**
// （Ke et al. 2026：BM25 在标识符密集语料上「exceptionally robust」，应作为默认而非兜底）。
// 本仓库 `Bm25Index{k1,b}` 自始可注入，但**全部生产调用点从未传参**（一律 1.5/0.75），
// 旋钮存在却从未被检验——本脚本补上这段证据。
//
// 口径（沿用 evals/recall-codebase-real.mjs）：
//   - 真实 src/ 语料（indexCorpus, morph:true, light:true）；
//   - 33 条真实查询 + 独立锚点（GT 由「文件文本含锚点串」确定，不依赖 BM25，避免自证循环）；
//   - 文件召回 = |GT ∩ surfaced| / |GT|，fileK=14；
//   - 硬守卫：锚点 GT=0 直接抛错（防 recall 兜底成 100% 污染统计）。
//
// 诚实统计（见 skill「噪声纪律」）：不止报点估计——同时给
//   ① 全网格均值；② bootstrap 95% CI（按查询重采 2000 次）；③ **留出折**（repeated 2-fold：
//   在 A 折选最优点、在 B 折评估）以揭示「最优是否只是在这 33 条上过拟合」。
//
// 用法：node evals/bm25-tune.mjs

import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { writeFileSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const DIST = join(ROOT, 'dist', 'src');
const importDist = (...segments) => import(pathToFileURL(join(DIST, ...segments)).href);

const { indexCorpus, query } = await importDist('context', 'contextEngine.js');

const SRC = join(ROOT, 'src');
const FILE_K = Number(process.env.OMNI_FILE_K ?? 14);
const SYM_K = 30;

// ── 语料与真值 ──────────────────────────────────────────────────────────────
const corpus = indexCorpus(SRC, { morph: true, light: true });
console.log(`[corpus] ${corpus.files.length} files, ${corpus.symbols.length} symbols`);

function groundTruth(anchor) {
  const needle = anchor.toLowerCase();
  const set = new Set();
  for (const [rel, text] of corpus.fileText) {
    if (text.toLowerCase().includes(needle)) set.add(rel);
  }
  return set;
}

// 与 evals/recall-codebase-real.mjs 完全同源的 33 条查询 + 锚点。
const QUERIES = [
  { q: 'where is tool registration handled', anchor: 'registerTool' },
  { q: 'how does sandbox denial escalate to approval', anchor: 'EscalationPort' },
  { q: 'what does ContextAssembler project events into', anchor: 'class ContextAssembler' },
  { q: 'how are images attached to model messages', anchor: 'imagesOf' },
  { q: 'where is reasoning_effort sent to the openai model', anchor: 'reasoning_effort' },
  { q: 'how does BM25 tokenize CJK text', anchor: 'export function tokenize' },
  { q: 'how is the resonant memory probe mapped from text', anchor: 'resonateByText' },
  { q: 'where is the sandbox policy evaluated', anchor: 'execPolicy' },
  { q: 'how are tool results spilled out of context', anchor: 'spill_read' },
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

// 锚点会随代码演进失效（如 OpenAiModelConfig 已不在语料）。纪律：跳过并记账，
// 既不静默吞掉（会污染绝对值），也不崩溃（历史脚本硬抛错导致无法出数）。
const GT_ALL = QUERIES.map((item) => groundTruth(item.anchor));
const ACTIVE = [];
const skipped = [];
for (let i = 0; i < QUERIES.length; i += 1) {
  if (GT_ALL[i].size === 0) skipped.push(QUERIES[i]);
  else ACTIVE.push(i);
}
if (skipped.length > 0) {
  console.log(`[guard] 跳过 GT=0 查询 ${skipped.length} 条（锚点已随语料演进失效）：`);
  for (const s of skipped) console.log(`  - "${s.q}" (anchor="${s.anchor}")`);
}
const N = ACTIVE.length;
const GT = ACTIVE.map((i) => GT_ALL[i]);
const Q = ACTIVE.map((i) => QUERIES[i].q);
console.log(`[queries] 有效 ${N} / 共 ${QUERIES.length}`);

/** 单条查询在给定 BM25 参数下的文件召回 ∈ [0,1]。 */
function recallOne(i, k1, b) {
  const res = query(corpus, Q[i], 20, { fileK: FILE_K, symK: SYM_K, bm25K1: k1, bm25B: b });
  const surfaced = new Set(res.files);
  const gt = GT[i];
  if (gt.size === 0) return 0;
  let hit = 0;
  for (const f of gt) if (surfaced.has(f)) hit += 1;
  return hit / gt.size;
}

// ── 网格 ────────────────────────────────────────────────────────────────────
const K1_GRID = [0.8, 1.0, 1.2, 1.5, 2.0, 3.0];
const B_GRID = [0.0, 0.25, 0.5, 0.75, 1.0];
const mean = (xs) => (xs.length === 0 ? 0 : xs.reduce((a, x) => a + x, 0) / xs.length);

console.log(`\n=== BM25 参数网格（fileK=${FILE_K}, ${N} 查询）===`);
console.log('  逐查询召回缓存中…');

// 逐 (k1,b,query) 只算一次，后续统计全部复用。
const cache = new Map(); // key `${k1}|${b}` → number[]
const combos = [];
for (const k1 of K1_GRID) {
  for (const b of B_GRID) {
    const rows = [];
    for (let i = 0; i < N; i += 1) rows.push(recallOne(i, k1, b));
    cache.set(`${k1}|${b}`, rows);
    combos.push({ k1, b, rows, avg: mean(rows) });
  }
}

const DEFAULT_K1 = 1.5;
const DEFAULT_B = 0.75;
const baselineRows = cache.get(`${DEFAULT_K1}|${DEFAULT_B}`);
const baselineAvg = mean(baselineRows);

combos.sort((a, c) => c.avg - a.avg);
console.log('\n  Top 组合（均值降序）：');
for (const c of combos.slice(0, 8)) {
  const d = (c.avg - baselineAvg) * 100;
  console.log(
    `    k1=${String(c.k1).padEnd(4)} b=${String(c.b).padEnd(5)} → ${(c.avg * 100).toFixed(1)}%  (${d >= 0 ? '+' : ''}${d.toFixed(1)}pp vs 默认)`,
  );
}
console.log(`\n  生产默认 k1=${DEFAULT_K1} b=${DEFAULT_B} → ${(baselineAvg * 100).toFixed(1)}%`);
const best = combos[0];

// ── bootstrap 95% CI（按查询重采，配对差）────────────────────────────────────
function bootstrapCI(a, bRows, rounds = 2000) {
  let seed = 20260915;
  const rnd = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 0x100000000;
  };
  const deltas = [];
  for (let r = 0; r < rounds; r += 1) {
    let sa = 0;
    let sb = 0;
    for (let i = 0; i < N; i += 1) {
      const j = Math.floor(rnd() * N);
      sa += a[j];
      sb += bRows[j];
    }
    deltas.push((sa - sb) / N);
  }
  deltas.sort((x, y) => x - y);
  const lo = deltas[Math.floor(0.025 * rounds)] ?? 0;
  const hi = deltas[Math.floor(0.975 * rounds)] ?? 0;
  return { lo: lo * 100, hi: hi * 100 };
}
const ci = bootstrapCI(best.rows, baselineRows);
console.log(
  `\n  [噪声检验] 最优增益 bootstrap 95% CI = [${ci.lo.toFixed(2)}, ${ci.hi.toFixed(2)}] pp（2000 次重采）`,
);

// ── 分布（up/down/flat）────────────────────────────────────────────────────
let up = 0;
let down = 0;
let flat = 0;
for (let i = 0; i < N; i += 1) {
  if (best.rows[i] > baselineRows[i]) up += 1;
  else if (best.rows[i] < baselineRows[i]) down += 1;
  else flat += 1;
}
console.log(`  分布：↑${up} / ↓${down} / =${flat}（共 ${N} 条）`);

// ── 留出折：repeated 2-fold —— 揭示「最优是否只是在这 33 条上过拟合」──────────
// 在 A 折选最优点、在 B 折评估；重复多组随机划分，报平均留出增益与其 CI。
function repeatedTwoFold(repeats = 20) {
  let seed = 7;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) >>> 0;
    return seed / 0x100000000;
  };
  const heldOut = [];
  for (let r = 0; r < repeats; r += 1) {
    const idx = [...Array(N).keys()].sort(() => rnd() - 0.5);
    const half = Math.floor(N / 2);
    const a = idx.slice(0, half);
    const bIdx = idx.slice(half);
    // 在 A 折选最优
    let bestA = null;
    let bestAAvg = -1;
    for (const k1 of K1_GRID) {
      for (const b of B_GRID) {
        const rows = cache.get(`${k1}|${b}`);
        const avg = mean(a.map((i) => rows[i]));
        if (avg > bestAAvg) {
          bestAAvg = avg;
          bestA = { k1, b };
        }
      }
    }
    const rowsBest = cache.get(`${bestA.k1}|${bestA.b}`);
    const gain = mean(bIdx.map((i) => rowsBest[i])) - mean(bIdx.map((i) => baselineRows[i]));
    heldOut.push(gain * 100);
  }
  return { mean: mean(heldOut), min: Math.min(...heldOut), max: Math.max(...heldOut) };
}
const held = repeatedTwoFold();
console.log(
  `\n  [留出折·repeated 2-fold×20] 平均留出增益 = ${held.mean >= 0 ? '+' : ''}${held.mean.toFixed(2)}pp ` +
    `(min ${held.min.toFixed(2)}, max ${held.max.toFixed(2)})`,
);

// ── 结论与报告 ──────────────────────────────────────────────────────────────
const selectionOptimistic = ci.hi > 0 && ci.lo <= 0;
const robust = ci.lo > 0 && held.mean > 0;
console.log('\n=== 结论 ===');
if (robust) {
  console.log(
    `  ✅ 调参有稳健增益：默认 k1=${DEFAULT_K1}/b=${DEFAULT_B}（${(baselineAvg * 100).toFixed(1)}%）` +
      ` → k1=${best.k1}/b=${best.b}（${(best.avg * 100).toFixed(1)}%，+${((best.avg - baselineAvg) * 100).toFixed(1)}pp）`,
  );
  console.log(`     CI 下界 > 0 且留出折为正 ⇒ 不是单点过拟合。`);
} else {
  console.log(
    `  ⚠️ 未检出稳健增益：默认 ${DEFAULT_K1}/${DEFAULT_B} 已在近似最优平台上；` +
      `最优 ${best.k1}/${best.b} 的优势 ${selectionOptimistic ? 'CI 跨 0（与噪声不可区分）' : '未通过留出折'}。`,
  );
  console.log(
    `     诚实结论：本语料上 BM25 参数不值得调（默认即近最优），**不翻默认**；此为「检索第一杠杆」的受控排除。`,
  );
}

writeFileSync(
  new URL('./bm25-tune.report.json', import.meta.url),
  JSON.stringify(
    {
      fileK: FILE_K,
      queryCount: N,
      skippedQueries: skipped.map((s) => ({ q: s.q, anchor: s.anchor })),
      corpus: { files: corpus.files.length, symbols: corpus.symbols.length },
      defaultParams: { k1: DEFAULT_K1, b: DEFAULT_B, avg: +(baselineAvg * 100).toFixed(2) },
      best: {
        k1: best.k1,
        b: best.b,
        avg: +(best.avg * 100).toFixed(2),
        deltaPp: +((best.avg - baselineAvg) * 100).toFixed(2),
      },
      bootstrapCI: { lo: +ci.lo.toFixed(2), hi: +ci.hi.toFixed(2), rounds: 2000 },
      distribution: { up, down, flat },
      heldOutTwoFold: {
        mean: +held.mean.toFixed(2),
        min: +held.min.toFixed(2),
        max: +held.max.toFixed(2),
        repeats: 20,
      },
      robust,
      grid: combos.map((c) => ({ k1: c.k1, b: c.b, avg: +(c.avg * 100).toFixed(2) })),
    },
    null,
    2,
  ),
);
console.log('\nWrote evals/bm25-tune.report.json');
