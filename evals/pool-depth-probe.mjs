#!/usr/bin/env node
// 调研实验：量化「候选池深度」这一免模型旋钮还有多少命中率空间。
//
// 背景（evals/headroom-analysis.mjs 实测）：
//   · 生产候选池 = BM25 文件路 Top-20 ∪ 符号路映射回的文件 ⇒ 实测池仅 24–53 个（全语料 482 文件）；
//   · 失败分两类：RANKING（GT 在池内但没进 Top-10）、LEXICAL（GT 被截断在池外）。
// 假设：把文件路召回深度由 20 放大，可把部分 LEXICAL 的 GT 捞回池内；
//       配合既有 FileReranker 仍有机会把 RANKING 的 GT 提进 Top-10。
//
// 本脚本**不改生产代码**，直接驱动底层索引 + 既有 FileReranker 复现生产排序逻辑，
// 扫描池深度 ∈ {20(现状), 40, 80, 150, 482(全语料)} × {不重排, 重排}，
// 输出命中率 hitRate@10 与准确度 precision@10。
//
// 诚实纪律：这是**上界/增益探测**，不是生产口径；若结论要进生产，须回源码接线并重跑
// evals/recall-precision.mjs（bootstrap CI 下界 > 基线）方可翻默认。
//
// 用法（免网络、免模型）：node evals/pool-depth-probe.mjs

import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { writeFileSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const DIST = join(ROOT, 'dist', 'src');
const importDist = (...segments) => import(pathToFileURL(join(DIST, ...segments)).href);

const { ContextEngine } = await importDist('context', 'contextEngine.js');
const { Bm25Index } = await importDist('search', 'bm25Index.js');
const { FileReranker } = await importDist('context', 'fileReranker.js');

const SRC = join(ROOT, 'src');
const K = 10;
const POOLS = [20, 40, 80, 150, 482];

const corpus = ContextEngine.indexCorpus(SRC, { morph: true, light: true });
const reranker = new FileReranker();
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
  { q: 'how does BM25 tokenize CJK text', anchor: 'public static tokenize' },
  { q: 'how is the resonant memory probe mapped from text', anchor: 'resonateByText' },
  { q: 'where is the sandbox policy evaluated', anchor: 'execPolicy' },
  { q: 'how are tool results spilled out of context', anchor: 'spill_read' },
  {
    q: 'which component remembers decisions the operator already blessed',
    anchor: 'ApprovalStore',
  },
  { q: 'how is a signed claim from an agent packaged', anchor: 'AgentAssertionEnvelope' },
  { q: 'which key-value store replicates records across nodes', anchor: 'OobleckStore' },
  { q: 'tuning knobs for the graph that links distant memories', anchor: 'ResonantFieldOptions' },
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

/**
 * 复现生产 query() 的候选池构建 + 排序（文件路），池深度参数化。
 * 对应 contextEngine.ts: fileIndex.search(qk, POOL) ∪ symbolIndex.search(qk, 60) 映射回的文件。
 */
function buildCandidates(q, pool) {
  const qk = Bm25Index.tokenizeExpanded(q);
  const fileHits = corpus.fileIndex.search(qk, pool);
  const symHits = corpus.symbolIndex.search(qk, 60);
  const score = new Map();
  for (const h of fileHits) {
    const rel = corpus.files[h.id]?.rel;
    if (rel !== undefined) score.set(rel, h.score);
  }
  // 符号路：0.7 权重（与生产一致），映射回文件
  for (const h of symHits) {
    const s = corpus.symbols[h.id];
    if (s === undefined) continue;
    const w = 0.7 * h.score;
    if (!score.has(s.file) || score.get(s.file) < w) score.set(s.file, w);
  }
  return [...score.entries()].sort((a, b) => b[1] - a[1]).map(([rel]) => rel);
}

function topK(q, pool, useRerank) {
  const candidates = buildCandidates(q, pool);
  if (!useRerank) return candidates.slice(0, K);
  return reranker.rerank({ corpus, query: q, candidates, fileK: K }).files;
}

const n = QUERIES.length;
const results = [];
console.log('\n=== 候选池深度 × 重排 扫描（hitRate@10 / precision@10）===');
for (const pool of POOLS) {
  for (const useRerank of [false, true]) {
    let hits = 0;
    let precSum = 0;
    const poolSizes = [];
    for (const { q, anchor } of QUERIES) {
      const gt = groundTruth(anchor);
      const cands = buildCandidates(q, pool);
      poolSizes.push(cands.length);
      const top = topK(q, pool, useRerank);
      const h = top.filter((f) => gt.has(f)).length;
      if (h > 0) hits++;
      precSum += top.length ? h / top.length : 0;
    }
    const hitRate = +((hits / n) * 100).toFixed(1);
    const precision = +((precSum / n) * 100).toFixed(1);
    const avgPool = +(poolSizes.reduce((a, b) => a + b, 0) / n).toFixed(1);
    results.push({ pool, rerank: useRerank, hitRate, precision, avgPool });
    console.log(
      `  pool=${String(pool).padStart(3)} ${useRerank ? 'rerank' : 'plain '}  ` +
        `命中率=${String(hitRate).padStart(5)}%  准确度=${String(precision).padStart(5)}%  (实际平均池=${avgPool})`,
    );
  }
}

writeFileSync(
  new URL('./pool-depth-probe.report.json', import.meta.url),
  JSON.stringify({ generatedAt: new Date().toISOString(), K, pools: POOLS, results }, null, 2),
);
console.log('\nWrote evals/pool-depth-probe.report.json');
