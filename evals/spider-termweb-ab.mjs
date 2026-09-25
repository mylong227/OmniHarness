#!/usr/bin/env node
// 蜘蛛网第三形态：**词项共现网**（term co-occurrence web）——网建在「词」上，不在「文件」上。
//
// 前序三次证伪（都记在案）：
//   ① PPR 单路排序：浅层 o@14 最高 51.5% < 池 60.6%（全面劣于词法）。
//   ② 扩张池 + 精排：+0.0pp（N 10→80 纹丝不动）。
//   ③ 配额保留 / 能量项：−6.1~−15.2pp（净负），LEXICAL 捞回 0/6。
//
// 机理诊断（本脚本的存在理由）：文件级图连的是「**结构性**关联」（共享稀有标识符），
// 而词法盲区要的是「**语义**关联」——
//   · `TranscriptChars`     ← "how many **characters** of a conversation are retained"
//   · `StoredTrace`         ← "how is a chain of thought **persisted** to disk"
//   · `Canonicalizer`       ← "what **normalizes** text before it is compared"
// 结构边在语义鸿沟上够不到 —— 不是调参问题，是**网的拓扑类型错了**。
//
// 第三形态：节点 = **内容词**，丝 = 该词对的语料级共现显著性（PMI），振动 = 查询词激活 → 沿丝传播，
// 中央蜘蛛 = 把激活分最高的「新词」按序补进查询（RM3 式**重排**而非并集），再由这些词去黏住猎物文件。
//
// 与既有手段的区别：
//   · RM3/PRF（已落地 opt-in）：只从**首轮 top-K 文件**取词 ⇒ 反馈源被首轮排序绑死；
//     本网是**语料级**词-词共现，能走「查询词 → 中介词 → 目标词」的多跳（RM3 走不了）。
//   · LSA（已证伪，精确率腰斩）：稠密降维引入噪声；本网是稀疏 PMI 边，只保留高显著共现。
//
// 判据：hitRate@14 的 bootstrap 95% CI 下界 > 基线。
// 用法：node evals/spider-termweb-ab.mjs
// 输出：evals/spider-termweb-ab.report.json + 控制台摘要。

import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { writeFileSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const DIST = join(ROOT, 'dist', 'src');
const importDist = (...segments) => import(pathToFileURL(join(DIST, ...segments)).href);

const { ContextEngine } = await importDist('context', 'contextEngine.js');
const { Bm25Index } = await importDist('search', 'bm25Index.js');
const { ContentStopWords } = await importDist('context', 'contentStopWords.js');

const SRC = join(ROOT, 'src');
const K = 14;
const TOPS = [2, 4, 6, 10];
/** PMI 阈值：只保留「共现显著高于独立假设」的词对。 */
const PMI_MIN = 1.0;
/** 词的最小文档频率：只出现 1 次的词做共现是纯噪声。 */
const MIN_DF = 2;
/** 每词保留最高的 top-N 共现邻居（控制度数与噪声）。 */
const NEIGHBOR_CAP = 12;

const corpus = ContextEngine.indexCorpus(SRC, { morph: true, light: true });
console.log(`语料：${corpus.files.length} 文件 / ${corpus.symbols.length} 符号`);

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

const gts = new Map();
for (const { q, anchor } of QUERIES) {
  const gt = groundTruth(anchor);
  if (gt.size === 0) throw new Error(`锚点不存在（GT=0）：query="${q}" anchor="${anchor}"`);
  gts.set(q, gt);
}

// —— 建词项共现网 ——
// 文档 = 单个文件；词 = 内容词（去停用词、长度≥3、形态归并后）。
const df = new Map();
const pairCount = new Map();
const fileTerms = [];
for (const [, text] of corpus.fileText) {
  const set = new Set();
  for (const t of Bm25Index.tokenizeExpanded(text)) {
    if (t.length < 3) continue;
    if (!ContentStopWords.isContent(t)) continue;
    set.add(t);
  }
  const arr = [...set];
  fileTerms.push(arr);
  for (const t of arr) df.set(t, (df.get(t) ?? 0) + 1);
}
const DOCS = fileTerms.length;
// 只保留 df ≥ MIN_DF 的词参与共现
const kept = new Set([...df.entries()].filter(([, d]) => d >= MIN_DF).map(([t]) => t));
for (const arr of fileTerms) {
  const a = arr.filter((t) => kept.has(t));
  for (let i = 0; i < a.length; i++) {
    for (let j = i + 1; j < a.length; j++) {
      const key = a[i] < a[j] ? `${a[i]}\u0000${a[j]}` : `${a[j]}\u0000${a[i]}`;
      pairCount.set(key, (pairCount.get(key) ?? 0) + 1);
    }
  }
}
console.log(`词表：${df.size} 词（df≥${MIN_DF} 者 ${kept.size}）/ 共现词对 ${pairCount.size}`);

// PMI 边（含每词 top-NEIGHBOR_CAP 截断）
const neighbors = new Map();
for (const [key, c] of pairCount) {
  if (c < 2) continue;
  const [x, y] = key.split('\u0000');
  const dx = df.get(x) ?? 0;
  const dy = df.get(y) ?? 0;
  const pmi = Math.log((c * DOCS) / (dx * dy));
  if (pmi < PMI_MIN) continue;
  for (const [src, dst] of [
    [x, y],
    [y, x],
  ]) {
    let arr = neighbors.get(src);
    if (arr === undefined) {
      arr = [];
      neighbors.set(src, arr);
    }
    arr.push([dst, pmi, c]);
  }
}
for (const [k, arr] of neighbors) {
  arr.sort((a, b) => b[1] - a[1]);
  neighbors.set(k, arr.slice(0, NEIGHBOR_CAP));
}
let edgeCount = 0;
for (const arr of neighbors.values()) edgeCount += arr.length;
console.log(
  `词网：${neighbors.size} 节点 / ${edgeCount} 有向边（PMI≥${PMI_MIN}，每词 top-${NEIGHBOR_CAP}）`,
);

/** 查询内容词（与 tokenizeExpanded 同源）。 */
function contentTerms(q) {
  const out = [];
  for (const t of Bm25Index.tokenizeExpanded(q)) {
    if (t.length < 3) continue;
    if (!ContentStopWords.isContent(t)) continue;
    if (!out.includes(t)) out.push(t);
  }
  return out;
}

/** 从查询词出发沿词网传播激活，返回按激活分降序的「新词」（不含查询词本身）。 */
function activate(q, hops) {
  const terms = contentTerms(q);
  const qset = new Set(terms);
  let energy = new Map(terms.map((t) => [t, 1]));
  const seen = new Map(energy);
  for (let h = 0; h < hops; h++) {
    const next = new Map();
    for (const [t, w] of energy) {
      for (const [n, pmi] of neighbors.get(t) ?? []) {
        const add = w * pmi;
        next.set(n, Math.max(next.get(n) ?? 0, add));
      }
    }
    for (const [t, w] of next) seen.set(t, Math.max(seen.get(t) ?? 0, w * 0.5));
    energy = next;
  }
  return [...seen.entries()]
    .filter(([t]) => !qset.has(t))
    .sort((a, b) => b[1] - a[1])
    .map(([t]) => t);
}

function measure(qText, gt) {
  const files = ContextEngine.query(corpus, qText, { fileK: K, rerank: true, prf: false }).files;
  const hits = files.filter((f) => gt.has(f)).length;
  return {
    hit: hits > 0 ? 1 : 0,
    hits,
    precision: files.length ? hits / files.length : 0,
    recall: gt.size ? hits / gt.size : 0,
    files,
  };
}

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

function crossQueryOverlap(filesByQuery) {
  const sets = [...filesByQuery.values()].map((f) => new Set(f.slice(0, K)));
  let sum = 0;
  let pairs = 0;
  for (let i = 0; i < sets.length; i++) {
    for (let j = i + 1; j < sets.length; j++) {
      let inter = 0;
      for (const x of sets[i]) if (sets[j].has(x)) inter++;
      sum += inter / K;
      pairs++;
    }
  }
  return pairs === 0 ? 0 : +(sum / pairs).toFixed(3);
}

// 基线：不加扩展
const baseRates = [];
const basePrec = [];
const baseRec = [];
const baseFiles = new Map();
for (const { q } of QUERIES) {
  const m = measure(q, gts.get(q));
  baseRates.push(m.hit);
  basePrec.push(m.precision);
  baseRec.push(m.recall);
  baseFiles.set(q, m.files);
}
const base = {
  hitRate: bootstrapCI(baseRates),
  precision: bootstrapCI(basePrec),
  recall: bootstrapCI(baseRec),
  overlap: crossQueryOverlap(baseFiles),
};
console.log(
  `\n基线（BM25 K=${K} + 精排，无扩展）：命中率 ${base.hitRate.mean}% [${base.hitRate.lo}, ${base.hitRate.hi}]`,
);

const rows = [];
for (const hops of [1, 2]) {
  for (const top of TOPS) {
    const hitRates = [];
    const precisions = [];
    const recalls = [];
    const filesByQuery = new Map();
    const expandedPerQ = new Map();
    for (const { q } of QUERIES) {
      const extra = activate(q, hops).slice(0, top);
      expandedPerQ.set(q, extra);
      const qText = extra.length > 0 ? `${q} ${extra.join(' ')}` : q;
      const m = measure(qText, gts.get(q));
      hitRates.push(m.hit);
      precisions.push(m.precision);
      recalls.push(m.recall);
      filesByQuery.set(q, m.files);
    }
    rows.push({
      hops,
      top,
      hitRate: bootstrapCI(hitRates),
      precision: bootstrapCI(precisions),
      recall: bootstrapCI(recalls),
      overlap: crossQueryOverlap(filesByQuery),
    });
    // 诊断：LEXICAL 6 条用哪几个扩展词
    if (hops === 1 && top === 6) {
      console.log('\n=== 词网为词法盲区查询选出的扩展词（1 跳 top-6）===');
      for (const { q, anchor } of QUERIES) {
        if (baseFiles.get(q).some((f) => gts.get(q).has(f))) continue;
        console.log(`  ${anchor.padEnd(28)} ← [${expandedPerQ.get(q).join(', ')}]`);
      }
    }
  }
}

console.log('\n=== 词项共现网扩展 AB（K=14，基线 = 无扩展）===');
console.log('  跳数 词数   命中率[95%CI]                Δ        准确度   召回   重合度');
for (const r of rows) {
  const delta = `${r.hitRate.mean - base.hitRate.mean >= 0 ? '+' : ''}${(r.hitRate.mean - base.hitRate.mean).toFixed(1)}pp`;
  console.log(
    `  ${String(r.hops).padStart(4)} ${String(r.top).padStart(4)}   ` +
      `${String(r.hitRate.mean).padStart(5)}% [${String(r.hitRate.lo).padStart(4)}, ${String(r.hitRate.hi).padStart(4)}]  ` +
      `${delta.padEnd(8)}  ${String(r.precision.mean).padStart(5)}%  ${String(r.recall.mean).padStart(5)}%  ${r.overlap}`,
  );
}

const report = {
  generatedAt: new Date().toISOString(),
  corpus: { files: corpus.files.length, symbols: corpus.symbols.length },
  termWeb: {
    nodes: neighbors.size,
    edges: edgeCount,
    pmiMin: PMI_MIN,
    neighborCap: NEIGHBOR_CAP,
    minDf: MIN_DF,
  },
  K,
  queryCount: QUERIES.length,
  base,
  rows,
};
writeFileSync(
  new URL('./spider-termweb-ab.report.json', import.meta.url),
  JSON.stringify(report, null, 2),
);
console.log('\nWrote evals/spider-termweb-ab.report.json');
