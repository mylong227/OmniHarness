#!/usr/bin/env node
// 调研：命中率 × 检索预算（fileK）权衡曲线 —— 回答「还能不能提升、代价是什么」。
//
// 起因（本次调研实测）：生产默认 fileK=10 且 rerank 默认关，命中率 51.5%；
// 而 reranker 在 fileK=10 只能排 10 个候选、施展不开（仅 +3.0pp），
// 到 fileK=14/20 时增益放大到 +9.1pp。即**真正被低估的杠杆是预算本身**，不是新算法。
//
// 本脚本扫描 fileK ∈ {5(P5 降档档), 10(生产默认), 14, 20} × {prf, rerank}，
// 输出命中率 hitRate / 准确度 precision / 召回 recall，**并对命中率做 bootstrap 95% CI**
// （重采样查询 B=2000，确定性 LCG），避免用点估计下结论。
//
// 同时输出 token 代价代理量（repo-map 输出的文件数 = fileK），让「命中率 vs 成本」可比。
//
// 诚实纪律：本脚本是**权衡测绘**，不是生产翻默认的依据。若要翻默认，须满足
// 两关（CI 下界 > 基线 且 留出折稳定为正）并回 evals/recall-precision.mjs 复核。
//
// 用法（免网络、免模型）：node evals/budget-recall-tradeoff.mjs

import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { writeFileSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const DIST = join(ROOT, 'dist', 'src');
const importDist = (...segments) => import(pathToFileURL(join(DIST, ...segments)).href);

const { indexCorpus, query } = await importDist('context', 'contextEngine.js');

const SRC = join(ROOT, 'src');
const FILE_KS = [5, 10, 14, 20];

const corpus = indexCorpus(SRC, { morph: true, light: true });
console.log(`语料：${corpus.files.length} 文件 / ${corpus.symbols.length} 符号`);

function groundTruth(anchor) {
  const needle = anchor.toLowerCase();
  const set = new Set();
  for (const [rel, text] of corpus.fileText) {
    if (text.toLowerCase().includes(needle)) set.add(rel);
  }
  return set;
}

// 与 evals/recall-precision.mjs 同源的 33 条查询。
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

/** bootstrap 95% CI（重采样查询，确定性 LCG）。 */
function bootstrapCI(values, B = 2000) {
  const n = values.length;
  if (n === 0) return { mean: 0, lo: 0, hi: 0 };
  const means = [];
  let seed = 0x9e3779b9;
  const rnd = () => {
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

const results = [];
console.log('\n=== 命中率 × 预算 权衡（33 查询，bootstrap 95% CI）===');
console.log('fileK prf rerank | 命中率 [CI下界–上界]       | 准确度 | 召回   | 相对默认');
let baseline = null;
for (const fileK of FILE_KS) {
  for (const prf of [false, true]) {
    for (const rerank of [false, true]) {
      const hits = [];
      const precs = [];
      const recs = [];
      for (const { q, anchor } of QUERIES) {
        const gt = groundTruth(anchor);
        const files = query(corpus, q, { fileK, prf, rerank }).files;
        const h = files.filter((f) => gt.has(f)).length;
        hits.push(h > 0 ? 1 : 0);
        precs.push(files.length ? h / files.length : 0);
        recs.push(gt.size ? h / gt.size : 0);
      }
      const hitRate = bootstrapCI(hits);
      const precision = bootstrapCI(precs);
      const recall = bootstrapCI(recs);
      const isDefault = fileK === 10 && !prf && !rerank;
      if (isDefault) baseline = hitRate.mean;
      results.push({
        fileK,
        prf,
        rerank,
        hitRate,
        precision,
        recall,
        filesSurfaced: fileK,
      });
      const rel =
        baseline === null
          ? ''
          : `  ${(hitRate.mean - baseline >= 0 ? '+' : '') + ((hitRate.mean - baseline) * 100).toFixed(1)}pp`;
      console.log(
        `${String(fileK).padStart(3)}   ${prf ? 'Y' : 'N'}   ${rerank ? 'Y' : 'N'}     | ` +
          `${(hitRate.mean * 100).toFixed(1).padStart(5)}% [${(hitRate.lo * 100).toFixed(1).padStart(5)}–${(hitRate.hi * 100).toFixed(1).padStart(5)}] | ` +
          `${(precision.mean * 100).toFixed(1).padStart(5)}% | ${(recall.mean * 100).toFixed(1).padStart(5)}% |${rel}`,
      );
    }
  }
}

console.log('\n=== 结论（相对生产默认 fileK=10, prf=N, rerank=N）===');
const base = results.find((r) => r.fileK === 10 && !r.prf && !r.rerank);
const best = results.reduce((a, b) => (b.hitRate.mean > a.hitRate.mean ? b : a));
for (const r of results) {
  const d = ((r.hitRate.mean - base.hitRate.mean) * 100).toFixed(1);
  if (r !== base) {
    console.log(
      `  fileK=${String(r.fileK).padStart(2)} prf=${r.prf ? 'Y' : 'N'} rerank=${r.rerank ? 'Y' : 'N'}  ` +
        `命中率 ${(r.hitRate.mean * 100).toFixed(1)}% (${d >= 0 ? '+' : ''}${d}pp)  ` +
        `CI下界 ${(r.hitRate.lo * 100).toFixed(1)}%  ` +
        `${r.hitRate.lo > base.hitRate.mean ? '✅ 下界已超基线' : '— 未超基线'}`,
    );
  }
}
console.log(
  `\n最优：fileK=${best.fileK} prf=${best.prf ? 'Y' : 'N'} rerank=${best.rerank ? 'Y' : 'N'} ` +
    `⇒ 命中率 ${(best.hitRate.mean * 100).toFixed(1)}%（较默认 +${((best.hitRate.mean - base.hitRate.mean) * 100).toFixed(1)}pp），` +
    `但 repo-map 文件数 ${base.fileK}→${best.fileK}（token 代价 ↑${((best.fileK / base.fileK - 1) * 100).toFixed(0)}%）`,
);

writeFileSync(
  new URL('./budget-recall-tradeoff.report.json', import.meta.url),
  JSON.stringify(
    { generatedAt: new Date().toISOString(), fileKs: FILE_KS, baselineFileK: 10, results },
    null,
    2,
  ),
);
console.log('\nWrote evals/budget-recall-tradeoff.report.json');
