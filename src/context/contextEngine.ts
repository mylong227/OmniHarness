/**
 * 零依赖上下文引擎（repo-map + BM25 检索式上下文）。
 *
 * 与「整文件硬塞」或「裸 grep 整文件」相比：用结构大纲 + 相关符号签名
 * 构成紧凑上下文，在同等相关文件召回下把 token 成本压低一个数量级。
 *
 * 这是「上下文效率碾压」这一可证伪命题的真实落地模块，不依赖任何外部服务。
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { Bm25Index, tokenize, tokenizeExpanded } from '../search/bm25Index.js';
import { extractSymbols, outlineText, type SymbolNode } from './repoMap.js';
import { eigenSpectrum, resonance, RESONANCE_BINS, type Spectrum } from '../util/eigenSpectrum.js';
import { buildCodeGraph, propagate, type CodeGraph } from './codeGraph.js';
import { trainLsa, lsaQuery, type LsaModel } from './lsaEngine.js';

/**
 * 空 LSA 模型（light 模式占位）：k=n=0、所有数组空。
 * `query` 仅在 `lsa:true` 时调用 `lsaQuery`；即便有人误开，n=0 让所有循环空转不崩。
 */
const EMPTY_LSA: LsaModel = {
  k: 0,
  n: 0,
  termIndex: new Map<string, number>(),
  symLatent: new Float64Array(0),
  U: new Float64Array(0),
  sigma: new Float64Array(0),
};

/** 空代码拓扑图（light 模式占位）：零节点零边。 */
const EMPTY_GRAPH: CodeGraph = { n: 0, adj: [] };

/** 代码停用词（PRF 扩展时剔除，避免高频噪声 token 污染查询）。 */
const CODE_STOP = new Set([
  'the',
  'and',
  'for',
  'this',
  'that',
  'with',
  'from',
  'import',
  'export',
  'const',
  'let',
  'var',
  'function',
  'return',
  'type',
  'interface',
  'class',
  'public',
  'private',
  'static',
  'async',
  'await',
  'if',
  'else',
  'new',
  'void',
  'string',
  'number',
  'boolean',
  'true',
  'false',
  'null',
  'undefined',
  'get',
  'set',
  'self',
  'in',
  'of',
  'to',
  'a',
  'an',
  'is',
  'are',
  'be',
  'as',
  'do',
  'it',
  'not',
  'use',
  'can',
  'will',
  'has',
  'have',
  'was',
  'were',
  'are',
  't',
]);

/** 已索引语料。 */
export interface IndexedCorpus {
  readonly root: string;
  /** 索引时是否启用词形归并；查询侧据此同步选择分词器（两侧须一致）。 */
  readonly morph: boolean;
  readonly symbols: readonly SymbolNode[];
  readonly files: readonly FileRecord[];
  readonly symbolIndex: Bm25Index;
  readonly fileIndex: Bm25Index;
  /** 每个符号的本征频谱（燧-3 频域召回），与 symbols 按索引一一对应。 */
  readonly symbolSpectra: readonly Spectrum[];
  /** 代码拓扑图（HippoRAG 式图检索，跨文件引用边），用于突破纯词法召回天花板。 */
  readonly codeGraph: CodeGraph;
  /** 潜语义（LSA）模型：把词与符号投影到潜空间，桥接词法错位型查询。 */
  readonly lsaModel: LsaModel;
  /** 原始文件内容（rel → text），供 baseline 计算整文件 token。 */
  readonly fileText: ReadonlyMap<string, string>;
}

interface FileRecord {
  readonly rel: string;
  readonly tokens: number;
}

function walk(root: string, absRoot: string, out: string[]): void {
  for (const entry of readdirSync(root)) {
    const abs = join(root, entry);
    const st = statSync(abs);
    if (st.isDirectory()) {
      if (entry === 'node_modules' || entry === 'dist' || entry.startsWith('.')) {
        continue;
      }
      walk(abs, absRoot, out);
    } else if (
      st.isFile() &&
      (entry.endsWith('.ts') || entry.endsWith('.js') || entry.endsWith('.py'))
    ) {
      out.push(relative(absRoot, abs).split(sep).join('/'));
    }
  }
}

/** 索引选项：morph 开启 camelCase 拆分 + 词形变体归并（默认开，关闭即退化回 Baseline）。 */
export interface IndexOptions {
  readonly morph?: boolean;
  /**
   * light 模式（生产默认开）：跳过频域共振谱、44 万边代码图、LSA SVD 三项重索引。
   * 2026-09-05 诚实重测：三项在 omniharness 语料上实测均零增益或净负面
   * （频谱同 corpus 隔离对照纯零效应；graph −3.6pp 确认负；LSA 无增量），故保持禁用。
   * 基准脚本仍可用 light:false 跑全量对照（含 graph/LSA/频谱）。
   */
  readonly light?: boolean;
}

/** 索引某个目录下的源码，构建符号级与文件级双 BM25 索引。 */
export function indexCorpus(root: string, opts: IndexOptions = {}): IndexedCorpus {
  // 索引侧与查询侧必须同用一套分词，否则两侧变体集不相交，归并反而掉召回。
  const tk = opts.morph === false ? tokenize : tokenizeExpanded;
  // light 模式：跳过三项重型索引（仅在全量基准里 light:false 才开启）。
  const light = opts.light === true;
  const files: string[] = [];
  walk(root, root, files);
  const fileText = new Map<string, string>();
  const allSymbols: SymbolNode[] = [];
  const fileRecords: FileRecord[] = [];
  const symbolDocs: string[][] = [];
  const fileDocs: string[][] = [];

  for (const rel of files) {
    let text: string;
    try {
      text = readFileSync(join(root, rel), 'utf8');
    } catch {
      continue;
    }
    fileText.set(rel, text);
    const toks = tokenize(text);
    fileRecords.push({ rel, tokens: toks.length });
    fileDocs.push([...toks, ...tk(rel)]);

    const syms = extractSymbols(rel, text);
    for (const s of syms) {
      allSymbols.push(s);
      symbolDocs.push(tk(`${s.name} ${s.kind} ${s.signature} ${s.file}`));
    }
  }

  const symbolIndex = new Bm25Index();
  symbolIndex.addDocuments(symbolDocs);
  const fileIndex = new Bm25Index();
  fileIndex.addDocuments(fileDocs);

  // 燧-3 频域索引：每个符号的名/类/签名映射到本征频谱，用于共振召回（与 BM25 时域/词袋互补）。
  // light 模式跳过（2026-09-05 诚实重测：同 corpus「频谱开/关」隔离对照，文件召回 41.4% = 41.4%
  // —— 纯零效应；此前某次「+2.5pp」是 full vs light 两语料混淆对比的假象）。频域共振/图/LSA 三项
  // 在 omniharness 语料上实测均零增益或净负面（详见 evals/validation-2026-09-05.md 第 9 节）。
  const symbolSpectra: Spectrum[] = light
    ? []
    : allSymbols.map((s) => eigenSpectrum(`${s.name} ${s.kind} ${s.signature}`, RESONANCE_BINS));

  // 代码拓扑图在语料齐全后再建（依赖 fileText 与 symbols 的完整映射）。light 模式跳过
  // （429k 稠密边 PageRank 实测零增益且额外增 token，净负面）。
  const codeGraph = light ? EMPTY_GRAPH : buildCodeGraph({ symbols: allSymbols, fileText });
  // 潜语义模型：在符号级 TF-IDF 上做截断 SVD（零依赖随机 SVD + Jacobi），训练一次随语料复用。
  // light 模式跳过：LSA 在 morph 之上实测符号精确率腰斩，净负面。
  const lsaModel = light ? EMPTY_LSA : trainLsa({ symbols: allSymbols, fileText });

  return {
    root,
    morph: opts.morph !== false,
    symbols: allSymbols,
    files: fileRecords,
    symbolIndex,
    fileIndex,
    symbolSpectra,
    fileText,
    codeGraph,
    lsaModel,
  };
}

/** 单次查询结果。 */
export interface QueryResult {
  /** 紧凑上下文文本（大纲 + 命中符号签名）。 */
  readonly context: string;
  /** 上下文 token 数。 */
  readonly tokens: number;
  /** 命中的符号。 */
  readonly symbols: readonly SymbolNode[];
  /** 命中的文件（按文件 BM25 排序）。 */
  readonly files: readonly string[];
}

/**
 * 检索式上下文（混合打分版）：
 * 每个文件的得分 = max(文件BM25分, 0.7 × 该文件内最强符号BM25分)。
 * 这样既保留文件级语义，又能把「文件级弱命中但含强相关符号」的文件（如 registerTool）
 * 捞回 Top-K，并在固定文件数上限内给出紧凑上下文——召回与压缩兼得。
 */
export function query(
  corpus: IndexedCorpus,
  q: string,
  k = 20,
  opts: { prf?: boolean; graph?: boolean; lsa?: boolean; fileK?: number; symK?: number } = {},
): QueryResult {
  // 图检索默认关闭：实测在本语料上净负面。
  // 根因（evals/rank-veto-retro.mjs 实测，已更正早期「收敛至近均匀」的错误解释）：
  // 图排序对查询不敏感——Top-14 跨查询重合度 0.936，而 BM25 仅 0.058，
  // 等于给每条查询塞同一批枢纽文件，构成常量偏置，挤掉真正相关的文件。
  // 保留模块与 graph:true 开关供稀疏高质量边/语义权重场景使用。
  const useGraph = opts.graph === true;
  // LSA 默认关闭：实测在「词形归并」之上叠加 LSA，召回无增益（67.0% 持平），
  // 但符号精确率从 25.5% 腰斩至 10.5%（潜语义扩展引入噪声，挤掉真相关符号）。
  // 模块保留（lsa:true 可开启），供后续改用更高秩/稀疏化后重新评估。
  const useLsa = opts.lsa === true;
  const qk = corpus.morph ? tokenizeExpanded(q) : tokenize(q);
  const FILE_K = opts.fileK ?? 14;
  const SYM_K = opts.symK ?? 30;
  let bm25SymHits = [...corpus.symbolIndex.search(qk, 60)];
  let fileHits = [...corpus.fileIndex.search(qk, 20)];

  // 伪相关反馈（PRF）：用第一轮 Top-3 文件的代码 token 高频词扩展查询，
  // 再搜一次并与原结果并集。这是经典 IR 技术，零依赖、可测，用于突破纯词法召回天花板。
  if (opts.prf) {
    const topFiles = fileHits
      .slice(0, 3)
      .map((h) => corpus.files[h.id]?.rel)
      .filter((r): r is string => r !== undefined);
    const fb = new Map<string, number>();
    for (const rel of topFiles) {
      const text = corpus.fileText.get(rel);
      if (text === undefined) continue;
      for (const t of tokenize(text)) {
        if (t.length < 3 || CODE_STOP.has(t)) continue;
        fb.set(t, (fb.get(t) ?? 0) + 1);
      }
    }
    const extra = [...fb.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .map((e) => e[0]);
    if (extra.length > 0) {
      const eqk = tokenize(`${q} ${extra.join(' ')}`);
      const s2 = corpus.symbolIndex.search(eqk, 60);
      const f2 = corpus.fileIndex.search(eqk, 20);
      for (const h of s2) if (!bm25SymHits.some((x) => x.id === h.id)) bm25SymHits.push(h);
      for (const h of f2) if (!fileHits.some((x) => x.id === h.id)) fileHits.push(h);
    }
  }

  // 燧-3 频域召回：把查询映射成频谱探针，与每个符号本征谱共振，取 Top-K 符号。
  // 与 BM25（词袋/时域）代数互补——频率偏移、字符分布差异可被频域捕获。
  const probe = eigenSpectrum(q, RESONANCE_BINS);
  const resHits: Array<{ id: number; score: number }> = [];
  for (let i = 0; i < corpus.symbolSpectra.length; i++) {
    const sp = corpus.symbolSpectra[i];
    if (sp === undefined) continue;
    const sc = resonance(sp, probe);
    if (sc > 1e-4) resHits.push({ id: i, score: sc });
  }
  resHits.sort((a, b) => b.score - a.score);
  const resSymIds = new Set(resHits.slice(0, SYM_K * 2).map((h) => h.id));

  // 潜语义（LSA）召回：把查询投影到潜空间，召回「概念相关」符号（桥接词法错位）。
  let lsaHits: Array<{ id: number; score: number }> = [];
  let lsaMax = 0;
  if (useLsa && corpus.lsaModel) {
    lsaHits = lsaQuery(corpus.lsaModel, q, 60);
    for (const h of lsaHits) lsaMax = Math.max(lsaMax, Math.abs(h.score));
  }

  // BM25 符号 ∪ 共振符号 ∪ LSA 符号（并集 → 作为图扩散的种子）。
  const symIdSet = new Set<number>();
  for (const h of bm25SymHits) symIdSet.add(h.id);
  for (const id of resSymIds) symIdSet.add(id);
  for (const h of lsaHits) symIdSet.add(h.id);

  // 种子分数：BM25 / 共振 / LSA 各自归一化后加权，作为 PageRank 重启向量。
  let bm25Max = 0;
  for (const h of bm25SymHits) bm25Max = Math.max(bm25Max, h.score);
  let resMax = 0;
  for (const h of resHits) resMax = Math.max(resMax, h.score);
  const seed = new Map<number, number>();
  for (const h of bm25SymHits) {
    if (bm25Max > 0) seed.set(h.id, (h.score / bm25Max) * 0.6);
  }
  for (const h of resHits) {
    const norm = resMax > 0 ? h.score / resMax : 0;
    const cur = seed.get(h.id) ?? 0;
    seed.set(h.id, Math.max(cur, norm * 0.4));
  }
  for (const h of lsaHits) {
    const norm = lsaMax > 0 ? Math.abs(h.score) / lsaMax : 0;
    const cur = seed.get(h.id) ?? 0;
    seed.set(h.id, Math.max(cur, norm * 0.5));
  }

  // 图扩散：把种子分数沿代码拓扑图传播，关联符号被抬升（突破纯词法天花板）。
  let finalScores: Float64Array;
  if (useGraph) {
    finalScores = propagate(corpus.codeGraph, seed, 4, 0.85);
    let fmax = 0;
    for (let i = 0; i < finalScores.length; i++) fmax = Math.max(fmax, finalScores[i]!);
    const THRESH = 0.12 * (fmax || 1);
    for (let i = 0; i < finalScores.length; i++) {
      if ((finalScores[i] ?? 0) >= THRESH) symIdSet.add(i);
    }
  } else {
    // 关图：直接以种子分数聚合，作为可对照的 baseline（= 上一轮 58.5% 配置）。
    finalScores = new Float64Array(corpus.symbols.length);
    for (const [id, v] of seed) {
      if (id >= 0 && id < finalScores.length) finalScores[id] = v;
    }
  }

  // 每个文件内最强符号分（用扩散后分值，关联符号被抬升 → 关联文件被捞回）。
  const bestSymbolScore = new Map<string, number>();
  for (const id of symIdSet) {
    const s = corpus.symbols[id];
    if (s === undefined) continue;
    const sc = finalScores[id] ?? 0;
    const cur = bestSymbolScore.get(s.file) ?? 0;
    if (sc > cur) bestSymbolScore.set(s.file, sc);
  }
  // 文件混合分。
  const fileScore = new Map<string, number>();
  for (const h of fileHits) {
    const f = corpus.files[h.id];
    if (f === undefined) continue;
    const sym = bestSymbolScore.get(f.rel) ?? 0;
    fileScore.set(f.rel, Math.max(h.score, 0.7 * sym));
  }
  for (const [file, sym] of bestSymbolScore) {
    if (!fileScore.has(file)) fileScore.set(file, 0.7 * sym);
  }
  const rankedFiles = [...fileScore.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, FILE_K)
    .map(([rel]) => rel);

  const symbols = [...symIdSet]
    .map((id) => ({ s: corpus.symbols[id], v: finalScores[id] ?? 0 }))
    .filter((x): x is { s: SymbolNode; v: number } => x.s !== undefined)
    .sort((a, b) => b.v - a.v)
    .slice(0, SYM_K)
    .map((x) => x.s);
  const fileSet = new Set(rankedFiles);

  const outline = outlineText(corpus.symbols.filter((s) => fileSet.has(s.file)));
  const sigLines = symbols.map((s) => `L${s.line} ${s.kind} ${s.name} @ ${s.file}`);
  const context = ['# Repo Map (relevant files)', outline, '# Relevant Symbols', ...sigLines].join(
    '\n',
  );

  return { context, tokens: tokenize(context).length, symbols, files: rankedFiles };
}

/** 整语料 token 总量（整文件硬塞 baseline 的上界）。 */
export function wholeCorpusTokens(corpus: IndexedCorpus): number {
  let total = 0;
  for (const f of corpus.files) {
    total += f.tokens;
  }
  return total;
}

/** 关键词命中 Top-N 文件的整文件 token 总和（真实竞品 baseline：grep→整文件）。 */
/**
 * 竞品 baseline（B）：关键词检索 → 取 Top-K 整文件。
 * 返回命中的文件相对路径，供基准同时测算「竞品召回率」——
 * 只比较我方召回、不比较竞品召回的成果对比是不公平的。
 */
export function grepTopKFiles(corpus: IndexedCorpus, q: string, k = 8): string[] {
  const qk = corpus.morph ? tokenizeExpanded(q) : tokenize(q);
  const hits = corpus.fileIndex.search(qk, k);
  const out: string[] = [];
  for (const h of hits) {
    const file = corpus.files[h.id];
    if (file !== undefined && corpus.fileText.has(file.rel)) out.push(file.rel);
  }
  return out;
}

/**
 * 取与查询最相关的 Top-K 文件，累加其 token 总量（用于预算/容量评估）。
 * @param corpus 已索引语料（含文件 token 计数）
 * @param q 查询字符串
 * @param k 取前 k 个文件（缺省 8）
 * @returns Top-K 文件的 token 总和
 */
export function grepTopKWholeFileTokens(corpus: IndexedCorpus, q: string, k = 8): number {
  const rels = grepTopKFiles(corpus, q, k);
  let total = 0;
  for (const rel of rels) {
    const rec = corpus.files.find((f) => f.rel === rel);
    if (rec !== undefined) total += rec.tokens;
  }
  return total;
}
