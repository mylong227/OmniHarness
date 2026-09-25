#!/usr/bin/env node
// 蜘蛛网最终形态：**形态丝**（字符级桥接）+ 一个必须澄清的**口径问题**。
//
// 前四次证伪（全部记在案，防止未来重复投入）：
//   ① 文件级 PPR 单路排序        —— 浅层 o@14 51.5% < 池 60.6%
//   ② 扩张池 + 精排              —— +0.0pp
//   ③ 配额保留 / 能量项          —— −6.1~−15.2pp
//   ④ 词项共现网（PMI）扩展      —— +0.0 ~ −6.1pp（选出的扩展词是「共现显著但不同义」的长尾词）
//
// 共性机理：本语料的**词法盲区**要的是「**同义/形态**关联」，而结构边与共现边给的是
// 「结构关联 / 同域共现」。零依赖的**分布统计**吃不到这批对抗查询的语义红利（与 LSA 证伪同源）。
//
// 本脚本只测两件仍有希望的事：
//   A. **形态丝**（prefix bridge）：查询词与语料词表做**字符前缀**桥接，专治缩写/形态鸿沟
//      （`characters` → `chars`、`Options` → `Opt`）。这是唯一有明确机理、且能桥接 LEXICAL 的手段。
//   B. **口径澄清**：本套 33 条查询是**刻意避开锚点字面词**的对抗样本（见 recall-precision.mjs 注释）。
//      本脚本同时测「**自然查询**」口径（用户直接说出符号名）—— 用它回答「网是否已无处不在」，
//      并界定 81.8% 这个天花板的**适用边界**（对抗口径 ≠ 生产现实）。
//
// 用法：node evals/spider-final-ab.mjs
// 输出：evals/spider-final-ab.report.json + 控制台摘要。

import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { writeFileSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const DIST = join(ROOT, 'dist', 'src');
const importDist = (...segments) => import(pathToFileURL(join(DIST, ...segments)).href);

const { indexCorpus, query } = await importDist('context', 'contextEngine.js');
const { tokenizeExpanded } = await importDist('search', 'bm25Index.js');
const { ContentStopWords } = await importDist('context', 'contentStopWords.js');

const SRC = join(ROOT, 'src');
const K = 14;
const PREFIX_LEN = 4;
const TOPS = [2, 4, 8];

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

/** 语料词表（内容词，df ≥ 2）+ 前缀倒排。 */
const dfCount = new Map();
for (const [, text] of corpus.fileText) {
  const set = new Set();
  for (const t of tokenizeExpanded(text)) {
    if (t.length < 3 || !ContentStopWords.isContent(t)) continue;
    set.add(t);
  }
  for (const t of set) dfCount.set(t, (dfCount.get(t) ?? 0) + 1);
}
const vocab = [...dfCount.entries()].filter(([, d]) => d >= 2).map(([t]) => t);
const byPrefix = new Map();
for (const t of vocab) {
  if (t.length < PREFIX_LEN) continue;
  const p = t.slice(0, PREFIX_LEN);
  let arr = byPrefix.get(p);
  if (arr === undefined) {
    arr = [];
    byPrefix.set(p, arr);
  }
  arr.push(t);
}
console.log(`词表：${vocab.length} 词（df≥2）/ 前缀桶 ${byPrefix.size}`);

function contentTerms(q) {
  const out = [];
  for (const t of tokenizeExpanded(q)) {
    if (t.length < 3 || !ContentStopWords.isContent(t)) continue;
    if (!out.includes(t)) out.push(t);
  }
  return out;
}

/**
 * 形态丝：对每个查询内容词，找**共享字符前缀**的语料词（含更长的前缀 = 更强的形态关联）。
 * @param {string} q 查询原文
 * @param {number} top 最多取几个扩展词
 * @returns {Array<[string, number]>} 扩展词与其形态相似度（共享前缀长度 / 较长词长度）
 */
function prefixBridge(q, top) {
  const terms = contentTerms(q);
  const tset = new Set(terms);
  const cand = new Map();
  for (const t of terms) {
    if (t.length < PREFIX_LEN) continue;
    for (let L = Math.min(t.length, 12); L >= PREFIX_LEN; L--) {
      const p = t.slice(0, L);
      for (const c of byPrefix.get(p.slice(0, PREFIX_LEN)) ?? []) {
        if (c === t || tset.has(c)) continue;
        // 共享前缀长度取「实际共同前缀」长度，避免桶内假共享
        let shared = 0;
        while (shared < t.length && shared < c.length && t[shared] === c[shared]) shared++;
        if (shared < PREFIX_LEN) continue;
        const sim = shared / Math.max(t.length, c.length);
        cand.set(c, Math.max(cand.get(c) ?? 0, sim));
      }
      break;
    }
  }
  return [...cand.entries()].sort((a, b) => b[1] - a[1]).slice(0, top);
}

const rerankStd = (qText) => query(corpus, qText, { fileK: K, rerank: true, prf: false }).files;

function measure(qText, gt) {
  const files = rerankStd(qText);
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

function runVariant(queries) {
  const rates = [];
  const precs = [];
  const recs = [];
  const filesByQuery = new Map();
  for (const { q, gt } of queries) {
    const m = measure(q, gt);
    rates.push(m.hit);
    precs.push(m.precision);
    recs.push(m.recall);
    filesByQuery.set(q, m.files);
  }
  return {
    hitRate: bootstrapCI(rates),
    precision: bootstrapCI(precs),
    recall: bootstrapCI(recs),
    overlap: crossQueryOverlap(filesByQuery),
  };
}

const adversarial = QUERIES.map(({ q }) => ({ q, gt: gts.get(q) }));
const base = runVariant(adversarial);
console.log(
  `\n[对抗口径] 基线（K=${K} + 精排）：命中率 ${base.hitRate.mean}% [${base.hitRate.lo}, ${base.hitRate.hi}]`,
);

const bridgeRows = [];
for (const top of TOPS) {
  const queries = [];
  const picked = [];
  for (const { q } of QUERIES) {
    const extra = prefixBridge(q, top);
    picked.push({ q, extra: extra.map(([c, s]) => `${c}(${s.toFixed(2)})`) });
    queries.push({
      q: extra.length > 0 ? `${q} ${extra.map(([c]) => c).join(' ')}` : q,
      gt: gts.get(q),
    });
  }
  const v = runVariant(queries);
  bridgeRows.push({ top, ...v });
  console.log(
    `[形态丝] 扩展 ${top} 词：命中率 ${v.hitRate.mean}% [${v.hitRate.lo}, ${v.hitRate.hi}]  ` +
      `(${v.hitRate.mean - base.hitRate.mean >= 0 ? '+' : ''}${(v.hitRate.mean - base.hitRate.mean).toFixed(1)}pp)  ` +
      `重合度 ${v.overlap}`,
  );
  if (top === 4) {
    console.log('\n=== 形态丝为词法盲区查询选出的扩展词 ===');
    for (const { q, extra } of picked) {
      if (baseFilesHasHit(q)) continue;
      console.log(`  ${String(q).slice(0, 52).padEnd(54)} ← [${extra.join(', ')}]`);
    }
  }
}
function baseFilesHasHit(q) {
  const m = measure(q, gts.get(q));
  return m.hit === 1;
}

// —— 口径澄清：自然查询（用户直接说出符号名/锚点）——
const natural = QUERIES.map(({ q, anchor }) => ({ q: `${anchor} ${q}`, gt: gts.get(q) }));
const nat = runVariant(natural);
const naturalPure = QUERIES.map(({ anchor, q }) => ({ q: anchor, gt: gts.get(q) }));
const natPure = runVariant(naturalPure);

console.log('\n=== 口径澄清：同一批锚点，三种提问方式 ===');
console.log(
  `  对抗口径（刻意避开锚点字面词，33 条）  命中率 ${base.hitRate.mean}% [${base.hitRate.lo}, ${base.hitRate.hi}]`,
);
console.log(
  `  自然口径（锚点 + 自然语言）           命中率 ${nat.hitRate.mean}% [${nat.hitRate.lo}, ${nat.hitRate.hi}]`,
);
console.log(
  `  直接指名（只给符号名）                命中率 ${natPure.hitRate.mean}% [${natPure.hitRate.lo}, ${natPure.hitRate.hi}]`,
);

const report = {
  generatedAt: new Date().toISOString(),
  corpus: { files: corpus.files.length, symbols: corpus.symbols.length },
  K,
  queryCount: QUERIES.length,
  adversarial: base,
  prefixBridge: bridgeRows,
  naturalQuery: nat,
  directName: natPure,
};
writeFileSync(
  new URL('./spider-final-ab.report.json', import.meta.url),
  JSON.stringify(report, null, 2),
);
console.log('\nWrote evals/spider-final-ab.report.json');
