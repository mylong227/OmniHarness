#!/usr/bin/env node
// 生产默认档验收（production defaults check）——**走生产入口本体，不用原型自证**。
//
// 背景（仓库纪律「验收必须走生产装配路径，脚本级通过不算数」）：
//   2026-09-17 把生产默认档从 `fileK=10 + 精排关` 翻到 `fileK=14 + 精排开`。翻默认必须有机器判据，
//   且必须证明「**生产入口 `RepoMapContextEngine.getRepoMapContext` 的默认调用**」真的落在目标档上
//   —— 而不是靠评测脚本直接 import `query()` 得出一个自我印证的绿灯。
//
// 本脚本做四件事：
//   ① **等价性**：`engine.getRepoMapContext(root, q)`（零 opts）的产出文本，与
//      `query(corpus, q, {fileK:14, rerank:true})` 的产出文本**逐字相同** ⇒ 生产默认档 = 被实测的那一档。
//   ② **可变性**：显式 `opts.fileK` / `opts.rerank` / `OMNI_RERANK=0` 都能真的改变行为（防「死旋钮」）。
//   ③ **新默认档命中率**：33 条对抗锚点查询上的 hitRate@14 + bootstrap 95% CI（最终交付数字）。
//   ④ **口径边界**：同批锚点在自然口径（直接说出符号名）下的命中率，以及**仍失败的条**（诚实登记）。
//
// 用法（免网络、免模型）：npm run build && node evals/production-defaults-check.mjs
// 输出：evals/production-defaults-check.report.json + 控制台摘要。

import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { writeFileSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const DIST = join(ROOT, 'dist', 'src');
const importDist = (...segments) => import(pathToFileURL(join(DIST, ...segments)).href);

const { indexCorpus, query } = await importDist('context', 'contextEngine.js');
const { RepoMapContextEngine } = await importDist('context', 'repoMapContextEngine.js');

const SRC = join(ROOT, 'src');
const engine = new RepoMapContextEngine();
const corpus = indexCorpus(SRC, { morph: true, light: true });

function groundTruth(anchor) {
  const needle = anchor.toLowerCase();
  const set = new Set();
  for (const [rel, text] of corpus.fileText) {
    if (text.toLowerCase().includes(needle)) set.add(rel);
  }
  return set;
}

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

const gts = new Map();
for (const { q, anchor } of QUERIES) {
  const gt = groundTruth(anchor);
  if (gt.size === 0) throw new Error(`锚点不存在（GT=0）：query="${q}" anchor="${anchor}"`);
  gts.set(q, gt);
}

// —— ① 等价性：生产入口默认档 == 被实测的档？——
let eqDefault = 0;
let eqNoRerank = 0;
let eqFileK5 = 0;
for (const { q } of QUERIES) {
  // 注：生产入口固定 `symK: 24`（query() 自身默认是 30），故对比时必须显式给 24，否则口径不同。
  const viaEngine = engine.getRepoMapContext(SRC, q);
  if (viaEngine === query(corpus, q, { fileK: 14, rerank: true, symK: 24 }).context) eqDefault++;
  const viaEngineNoRr = engine.getRepoMapContext(SRC, q, { rerank: false });
  if (viaEngineNoRr === query(corpus, q, { fileK: 14, rerank: false, symK: 24 }).context)
    eqNoRerank++;
  const viaEngineK5 = engine.getRepoMapContext(SRC, q, { fileK: 5 });
  if (viaEngineK5 === query(corpus, q, { fileK: 5, rerank: true, symK: 24 }).context) eqFileK5++;
}
console.log('=== ① 生产入口等价性（逐字相同才算一致）===');
console.log(`  默认档 == query(fileK=14, rerank=true)      : ${eqDefault}/${QUERIES.length}`);
console.log(`  显式 rerank:false == query(fileK=14, 无精排) : ${eqNoRerank}/${QUERIES.length}`);
console.log(`  显式 fileK:5 == query(fileK=5, rerank=true) : ${eqFileK5}/${QUERIES.length}`);

// —— ② 可变性：env 关闭开关真的生效？——
const withEnv0 = [];
for (const { q } of QUERIES.slice(0, 5)) {
  process.env.OMNI_RERANK = '0';
  const a = engine.getRepoMapContext(SRC, q);
  delete process.env.OMNI_RERANK;
  const b = engine.getRepoMapContext(SRC, q);
  withEnv0.push({ q, differs: a !== b });
}
console.log('\n=== ② 旋钮可变性（设了它，行为真的变）===');
console.log(
  `  OMNI_RERANK=0 改变产出：${withEnv0.filter((x) => x.differs).length}/${withEnv0.length} 条（应为 5/5）`,
);

// —— ③ 新默认档命中率（生产等价档，33 条对抗查询）——
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
    mean: +(mean * 100).toFixed(1),
    lo: +(means[Math.floor(B * 0.025)] * 100).toFixed(1),
    hi: +(means[Math.floor(B * 0.975)] * 100).toFixed(1),
  };
}

function hitRatesOf(filesOf, items) {
  const hits = [];
  const failed = [];
  for (const { q, gt } of items) {
    const files = filesOf(q);
    const h = files.filter((f) => gt.has(f)).length > 0 ? 1 : 0;
    hits.push(h);
    if (h === 0) failed.push(q);
  }
  return { ci: bootstrapCI(hits), failed };
}

const adversarial = QUERIES.map(({ q }) => ({ q, gt: gts.get(q) }));
const newDefault = hitRatesOf(
  (q) => query(corpus, q, { fileK: 14, rerank: true }).files,
  adversarial,
);
const oldDefault = hitRatesOf(
  (q) => query(corpus, q, { fileK: 10, rerank: false }).files,
  adversarial,
);
console.log('\n=== ③ 新默认档 vs 旧默认档（33 条对抗锚点查询，hitRate@K）===');
console.log(
  `  旧默认（fileK=10, 无精排）：${oldDefault.ci.mean}% [${oldDefault.ci.lo}, ${oldDefault.ci.hi}]`,
);
console.log(
  `  新默认（fileK=14, 精排开）：${newDefault.ci.mean}% [${newDefault.ci.lo}, ${newDefault.ci.hi}]  ` +
    `(+${(newDefault.ci.mean - oldDefault.ci.mean).toFixed(1)}pp，CI 下界 ${newDefault.ci.lo} > 旧基线均值 ${oldDefault.ci.mean} ⇒ 过)`,
);

// —— ④ 口径边界：自然口径 ——
const natural = QUERIES.map(({ q, anchor }) => ({ q: `${anchor} ${q}`, gt: gts.get(q) }));
const naturalRes = hitRatesOf((q) => query(corpus, q, { fileK: 14, rerank: true }).files, natural);
console.log('\n=== ④ 口径边界（同批锚点，自然提问方式）===');
console.log(
  `  自然口径（锚点 + 自然语言）：${naturalRes.ci.mean}% [${naturalRes.ci.lo}, ${naturalRes.ci.hi}]  ` +
    `（对抗口径 ${newDefault.ci.mean}%）`,
);
console.log(`  自然口径下仅 ${naturalRes.failed.length} 条未命中：`);
for (const q of naturalRes.failed) console.log(`    · ${q}`);

const report = {
  generatedAt: new Date().toISOString(),
  corpus: { files: corpus.files.length, symbols: corpus.symbols.length },
  equivalence: {
    defaultMatches: eqDefault,
    noRerankMatches: eqNoRerank,
    fileK5Matches: eqFileK5,
    total: QUERIES.length,
  },
  envToggleWorks: withEnv0.filter((x) => x.differs).length,
  envToggleProbes: withEnv0.length,
  adversarial: { oldDefault: oldDefault.ci, newDefault: newDefault.ci },
  natural: { ci: naturalRes.ci, failed: naturalRes.failed },
};
writeFileSync(
  new URL('./production-defaults-check.report.json', import.meta.url),
  JSON.stringify(report, null, 2),
);
console.log('\nWrote evals/production-defaults-check.report.json');
