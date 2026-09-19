/**
 * 确定性上下文效率基准（无实时模型依赖，可复现）。
 *
 * 对比三种「把代码库喂给模型」的策略在真实语料上的 token 成本与召回：
 *   A. 整语料硬塞（whole-corpus）        —— 上界 baseline
 *   B. 关键词 Top-K 整文件（grep→file）  —— 真实竞品 baseline（Claude Code / ripgrep 类）
 *   C. OmniHarness 检索式上下文（repo-map + BM25 符号） —— 被测方案
 *
 * 标准答案（ground truth）用「独立字符串锚点」在语料中定位，不依赖 BM25，避免自证循环。
 */
import {
  indexCorpus,
  query,
  wholeCorpusTokens,
  grepTopKWholeFileTokens,
  grepTopKFiles,
} from '../../.xeval/context/contextEngine.js';

const ROOT = process.argv[2] || 'src';

// 三配置 A/B：索引两套语料（词形归并关/开），查询侧自动跟随 corpus.morph 保持一致。
// 本基准要打印 corpus.codeGraph 边数（full 模式独有）⇒ 显式声明 light:false（默认已翻为 light）。
const corpusBase = indexCorpus(ROOT, { morph: false, light: false }); // Baseline：既有实现原样
const corpusMorph = indexCorpus(ROOT, { morph: true, light: false }); // + camelCase 拆分 & 词形变体归并
const corpus = corpusMorph; // 对数/语料统计以归并版为准（文件集相同）
const whole = wholeCorpusTokens(corpus);
const edgeCount = corpus.codeGraph.adj.reduce((a, e) => a + e.length, 0);
console.log(
  `corpus: ${corpus.files.length} files, ${corpus.symbols.length} symbols, graph edges=${edgeCount}`,
);

// 查询 + 独立锚点（锚点字符串用于无偏定位「答案所在文件」）。
const QUERIES = [
  { q: 'where is tool registration handled', anchor: 'registerTool' },
  { q: 'how does sandbox denial escalate to approval', anchor: 'EscalationPort' },
  { q: 'what does ContextAssembler project events into', anchor: 'class ContextAssembler' },
  { q: 'where is the audit hash chain computed', anchor: 'prevHash' },
  { q: 'how are images attached to model messages', anchor: 'imagesOf' },
  { q: 'where is reasoning_effort sent to the openai model', anchor: 'reasoning_effort' },
  { q: 'how does BM25 tokenize CJK text', anchor: 'export function tokenize' },
  { q: 'how is the resonant memory probe mapped from text', anchor: 'resonateByText' },
  { q: 'where is the sandbox policy evaluated', anchor: 'execPolicy' },
  { q: 'how are tool results spilled out of context', anchor: 'spill_read' },
];

// 独立 ground truth：含锚点字符串的文件集合（大小写不敏感）。
function groundTruth(anchor) {
  const needle = anchor.toLowerCase();
  const set = new Set();
  for (const [rel, text] of corpus.fileText) {
    if (text.toLowerCase().includes(needle)) set.add(rel);
  }
  return set;
}

// 三配置：baseline（既有实现）/ morph（+词形归并）/ morph_lsa（+词形归并+潜语义）
const CONFIGS = [
  { name: 'baseline', corpus: corpusBase, opts: { prf: false, graph: false, lsa: false } },
  { name: 'morph', corpus: corpusMorph, opts: { prf: false, graph: false, lsa: false } },
  { name: 'morph_lsa', corpus: corpusMorph, opts: { prf: false, graph: false, lsa: true } },
];

const acc = new Map(CONFIGS.map((c) => [c.name, { rg: 0, rw: 0, recall: 0, sym: 0 }]));
const rows = [];

/** 我方查询返回的文件预算（FILE_K）。公平对照需让竞品拿到同等文件数。 */
const OUR_FILE_BUDGET = 14;
let sumGrepRecall8 = 0;
let sumGrepRecall14 = 0;
let sumGrepTok14 = 0;

for (const { q, anchor } of QUERIES) {
  const gt = groundTruth(anchor);
  const row = { q, gt: gt.size };

  // 竞品 baseline（Claude Code / ripgrep 类：关键词检索 → 整文件）用其自有分词器（corpusBase）。
  const gram = (k) => {
    const files = new Set(grepTopKFiles(corpusBase, q, k));
    const hit = [...gt].filter((f) => files.has(f)).length;
    return gt.size > 0 ? hit / gt.size : 1;
  };
  row.grep_recall8 = +(gram(8) * 100).toFixed(1);
  row.grep_recall14 = +(gram(OUR_FILE_BUDGET) * 100).toFixed(1);
  row.grep = grepTopKWholeFileTokens(corpusBase, q, 8);
  row.grep14 = grepTopKWholeFileTokens(corpusBase, q, OUR_FILE_BUDGET);
  sumGrepRecall8 += row.grep_recall8;
  sumGrepRecall14 += row.grep_recall14;
  sumGrepTok14 += row.grep14;

  for (const cfg of CONFIGS) {
    const res = query(cfg.corpus, q, cfg.opts);
    const files = new Set(res.files);
    const hit = [...gt].filter((f) => files.has(f)).length;
    const recall = gt.size > 0 ? hit / gt.size : 1;
    const symInGt = res.symbols.filter((s) => gt.has(s.file)).length;
    const symPrec =
      Math.min(res.symbols.length, 20) > 0 ? symInGt / Math.min(res.symbols.length, 20) : 0;
    const ratioGrep = row.grep > 0 ? row.grep / res.tokens : 0;
    const ratioWhole = whole > 0 ? whole / res.tokens : 0;
    // 同等文件预算对照：竞品也给 OUR_FILE_BUDGET 个整文件时，我方省多少 token。
    const ratioGrep14 = row.grep14 > 0 ? row.grep14 / res.tokens : 0;

    const a = acc.get(cfg.name);
    a.rg += ratioGrep;
    a.rw += ratioWhole;
    a.recall += recall;
    a.sym += symPrec;
    a.rg14 = (a.rg14 ?? 0) + ratioGrep14;

    row[`${cfg.name}_tokens`] = res.tokens;
    row[`${cfg.name}_recall`] = +(recall * 100).toFixed(1);
    row[`${cfg.name}_symPrec`] = +(symPrec * 100).toFixed(1);
    row[`${cfg.name}_xGrep`] = +ratioGrep.toFixed(1);
    row[`${cfg.name}_xGrep14`] = +ratioGrep14.toFixed(1);
    row[`${cfg.name}_xWhole`] = +ratioWhole.toFixed(1);
  }
  rows.push(row);
}

const n = QUERIES.length;
const avg = (x) => +(x / n).toFixed(2);
const cfgSummary = (name) => {
  const a = acc.get(name);
  return {
    avg_ratio_vs_grep_top8: avg(a.rg),
    avg_ratio_vs_grep_top14_equal_budget: avg(a.rg14 ?? 0),
    avg_ratio_vs_whole_corpus: avg(a.rw),
    avg_file_recall_pct: avg(a.recall * 100),
    avg_symbol_precision_pct: avg(a.sym * 100),
  };
};
const summary = {
  corpus_files: corpus.files.length,
  corpus_symbols: corpus.symbols.length,
  whole_corpus_tokens: whole,
  competitor_baseline: {
    grep_top8_recall_pct: avg(sumGrepRecall8),
    grep_top14_recall_pct_equal_budget: avg(sumGrepRecall14),
    grep_top14_tokens: avg(sumGrepTok14),
  },
  baseline: cfgSummary('baseline'),
  morph: cfgSummary('morph'),
  morph_lsa: cfgSummary('morph_lsa'),
};

console.log('\n=== Per-query (recall %: grepTop8 / grepTop14 / baseline / morph / morph+lsa) ===');
for (const r of rows) {
  console.log(
    `${r.q.padEnd(50)} | GT=${String(r.gt).padStart(2)} ` +
      `| grep ${String(r.grep_recall8).padStart(5)}%/${String(r.grep_recall14).padStart(5)}% ` +
      `| ours ${String(r.baseline_recall).padStart(5)}%/${String(r.morph_recall).padStart(5)}%/` +
      `${String(r.morph_lsa_recall).padStart(5)}% ` +
      `| tok grep8=${String(r.grep).padStart(5)} grep14=${String(r.grep14).padStart(5)} ` +
      `ours=${r.baseline_tokens}/${r.morph_tokens}/${r.morph_lsa_tokens}`,
  );
}
console.log('\n=== Summary ===');
console.log(JSON.stringify(summary, null, 2));

// 落盘，供看板/报告引用。
import { writeFileSync } from 'node:fs';
writeFileSync(
  new URL('./RESULTS.json', import.meta.url),
  JSON.stringify({ summary, rows }, null, 2),
);
console.log('\nWrote RESULTS.json');
