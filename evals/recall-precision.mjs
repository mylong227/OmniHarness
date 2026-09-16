#!/usr/bin/env node
// 检索「命中率 / 准确度」受控度量（纯 BM25，免网络、免模型）。
//
// 回答用户的「抓命中率，准确度」：在真实 src/ 语料上，用 33 条已核实锚点查询，
// 对生产级 getRepoMapContext（纯 BM25 repo-map）计算：
//   - 命中率 hitRate@K   = 有多少比例查询在 top-K 里至少命中 1 个相关文件（recall@K>0）
//   - 准确度 precision@K = 被召回的 top-K 文件中，有多大比例确实是相关文件
//   - 召回   recall@K    = 相关文件被召回的比例（标准文件召回）
//   - MRR                = 第一个相关文件排位的倒数均值
// 并在 K∈{5,10,14} 上给出（production 默认 =10；P5 降档 =5；判定档 =14）。
//
// 诚实纪律（沿用 recall-codebase-real.mjs）：
//   - 锚点必须真实存在于语料（GT≥1），否则直接失败，不允许 recall 兜底成 100% 污染统计。
//   - 报告 bootstrap 95% CI（重采样查询 B=2000），不报点估计；翻默认须 CI 下界 > 基线。
//
// 用法（免网络）：
//   node evals/recall-precision.mjs                 # 基线 BM25 + RM3 扩展对照
//   node evals/recall-precision.mjs --no-rm3        # 仅基线
// 输出：evals/recall-precision.report.json + 控制台摘要。

import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { writeFileSync, appendFileSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const DIST = join(ROOT, 'dist', 'src');
const importDist = (...segments) => import(pathToFileURL(join(DIST, ...segments)).href);

const PLOG = join(ROOT, 'recall-precision-progress.log');
writeFileSync(PLOG, `start ${new Date().toISOString()}\n`);
const log = (m) => appendFileSync(PLOG, m + '\n');

// 直接复用生产检索核心 query()（getRepoMapContext 内部即调用它，default rerank=false），
// 读取其返回的 ranked 文件数组，避免解析 context 字符串（生产 context 用 # Repo Map / # Relevant
// Symbols 分节，无 📄 标记，字符串解析会丢文件）。与生产口径逐字一致。
const { indexCorpus, query } = await importDist('context', 'contextEngine.js');

const SRC = join(ROOT, 'src');
const KS = [5, 10, 14];
const NO_RM3 = process.argv.includes('--no-rm3');

// 语料（用于无偏 ground truth：含锚点字符串的文件集合）。
const corpus = indexCorpus(SRC, { morph: true, light: true });
log(`[1] corpus indexed: ${corpus.files.length} files, ${corpus.symbols.length} symbols`);

function groundTruth(anchor) {
  const needle = anchor.toLowerCase();
  const set = new Set();
  for (const [rel, text] of corpus.fileText) {
    if (text.toLowerCase().includes(needle)) set.add(rel);
  }
  return set;
}

// 33 个真实查询 + 独立锚点（锚点字符串定位答案文件，不依赖 BM25，避免自证循环）。
// 刻意用自然语言改写、避开锚点字面词（制造词法鸿沟），与 recall-codebase-real.mjs 同源。
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
  { q: 'how is the chat completion provider configured', anchor: 'OpenAiCompatibleModel' },
  { q: 'where do language server error reports come from', anchor: 'Diagnostics' },
  { q: 'how many characters of a conversation are retained', anchor: 'TranscriptChars' },
  { q: 'what does a delegated child task return', anchor: 'SubagentResult' },
  { q: 'what represents one entry in a multi stage plan', anchor: 'PlanStep' },
  { q: 'where are capabilities discovered and registered', anchor: 'SkillRegistry' },
  { q: 'which component gates dangerous tool calls at runtime', anchor: 'SupervisorKernel' },
];

// 硬守卫：锚点不存在 → 直接失败。
for (const { q, anchor } of QUERIES) {
  if (groundTruth(anchor).size === 0) {
    throw new Error(`锚点在语料中不存在（GT=0）：query="${q}" anchor="${anchor}"`);
  }
}

// 注：生产 repo-map context 用 `# Repo Map (relevant files)` / `# Relevant Symbols` 分节，
// 无 📄 标记符；故不再解析字符串，直接读 query() 返回的 ranked 文件数组（见 measure / expandQuery）。

// 语料级 docFreq 已不再需要（改用引擎内置 prf，与生产 getRepoMapContext 逐字一致）。

// 对一个查询 + 给定 K，取 repo-map 结果（prf=true 即引擎内置 PRF/RM3 扩展），
// 算四项指标。prf 直接透传给 query()，确保度量的是**真实生产算法**。
function measure(qText, gt, K, prf = false) {
  const surf = query(corpus, qText, { fileK: K, rerank: false, prf }).files;
  const hits = surf.filter((f) => gt.has(f)).length;
  const recall = gt.size ? hits / gt.size : 0;
  const precision = surf.length ? hits / surf.length : 0;
  // MRR：第一个相关文件的排位倒数（surf 有序）。
  let rank = -1;
  for (let i = 0; i < surf.length; i++) {
    if (gt.has(surf[i])) {
      rank = i + 1;
      break;
    }
  }
  const mrr = rank > 0 ? 1 / rank : 0;
  return { hits, recall, precision, mrr, surfCount: surf.length };
}

// bootstrap 95% CI（重采样查询，B 次）。
function bootstrapCI(values, B = 2000) {
  const n = values.length;
  if (n === 0) return { mean: 0, lo: 0, hi: 0 };
  const means = [];
  let seed = 0x9e3779b9;
  const rnd = () => {
    // 确定性 LCG，免依赖。
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 0xffffffff;
  };
  for (let b = 0; b < B; b++) {
    let s = 0;
    for (let i = 0; i < n; i++) s += values[Math.floor(rnd() * n)];
    means.push(s / n);
  }
  means.sort((a, b) => a - b);
  const mean = values.reduce((a, b) => a + b, 0) / n;
  return {
    mean: +mean.toFixed(4),
    lo: +means[Math.floor(B * 0.025)].toFixed(4),
    hi: +means[Math.floor(B * 0.975)].toFixed(4),
  };
}

const variants = NO_RM3
  ? [{ name: 'BM25', expand: false }]
  : [
      { name: 'BM25', expand: false },
      { name: 'BM25+RM3', expand: true },
    ];

const report = { queryCount: QUERIES.length, fileK: KS, variants: [] };
for (const v of variants) {
  log(`[run] variant=${v.name}`);
  const perK = {};
  for (const K of KS) {
    const recalls = [];
    const precisions = [];
    const hitRates = [];
    const mrrs = [];
    const rows = [];
    for (const { q, anchor } of QUERIES) {
      const gt = groundTruth(anchor);
      const m = measure(q, gt, K, v.expand);
      recalls.push(m.recall);
      precisions.push(m.precision);
      hitRates.push(m.recall > 0 ? 1 : 0);
      mrrs.push(m.mrr);
      rows.push({
        q,
        gt: gt.size,
        K,
        hits: m.hits,
        surf: m.surfCount,
        recall: +(m.recall * 100).toFixed(1),
        precision: +(m.precision * 100).toFixed(1),
        hit: m.recall > 0 ? 1 : 0,
        mrr: +m.mrr.toFixed(3),
      });
    }
    perK[K] = {
      recall: bootstrapCI(recalls),
      precision: bootstrapCI(precisions),
      hitRate: bootstrapCI(hitRates),
      mrr: bootstrapCI(mrrs),
      rows,
    };
    const r = perK[K].recall;
    const p = perK[K].precision;
    const h = perK[K].hitRate;
    console.log(
      `  ${v.name.padEnd(10)} K=${String(K).padStart(2)}  命中率=${(h.mean * 100).toFixed(1)}%  ` +
        `准确度(P@K)=${(p.mean * 100).toFixed(1)}%  recall@K=${(r.mean * 100).toFixed(1)}%  MRR=${perK[K].mrr.mean.toFixed(3)}`,
    );
  }
  report.variants.push({ name: v.name, perK });
}

writeFileSync(
  new URL('./recall-precision.report.json', import.meta.url),
  JSON.stringify(report, null, 2),
);
console.log('Wrote evals/recall-precision.report.json');
log('[done]');
