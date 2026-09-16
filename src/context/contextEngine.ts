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
import { eigenSpectrum, resonance, RESONANCE_BINS, type Spectrum } from '../util/eigenspectrum.js';
import { buildCodeGraph, propagate, type CodeGraph } from './codeGraphIndex.js';
import { buildLayeredCodeGraph } from './layeredCodeGraph.js';
import { trainLsa, lsaQuery, type LsaModel } from './lsaEngine.js';
import { at } from '../util/arrayAt.js';
import { ContentStopWords } from './contentStopWords.js';
import { FileReranker } from './fileReranker.js';

/**
 * ContextEngine 相关纯函数工具（C7 收口：原顶层内部函数迁入）。
 */
export class ContextEngine {
  /**
   * C7 收口：原顶层内部函数迁入宿主类。
   * @param root string
   * @param absRoot string
   * @param out string[]
   * @returns void
   */
  public static walk(root: string, absRoot: string, out: string[]): void {
    for (const entry of readdirSync(root)) {
      const abs = join(root, entry);
      const st = statSync(abs);
      if (st.isDirectory()) {
        if (entry === 'node_modules' || entry === 'dist' || entry.startsWith('.')) {
          continue;
        }
        ContextEngine.walk(abs, absRoot, out);
      } else if (
        st.isFile() &&
        (entry.endsWith('.ts') || entry.endsWith('.js') || entry.endsWith('.py'))
      ) {
        out.push(relative(absRoot, abs).split(sep).join('/'));
      }
    }
  }

  /**
   * 层化图构建缓存：按语料实例 WeakMap 缓存，避免每次查询重扫全仓建边。
   * E4 深化：层化图作为第三路软融合并入 `query` 的 fileScore（见 `query` 内 useLayered 分支）。
   */
  private static readonly layeredGraphCache = new WeakMap<IndexedCorpus, CodeGraph>();

  /**
   * 取（或构建并缓存）某语料的层化代码图。
   * @param corpus 已索引语料（含 symbols 与 fileText，满足 GraphSource 视图）
   * @returns 层化有向带权邻接表
   */
  public static getLayeredGraph(corpus: IndexedCorpus): CodeGraph {
    const cached = ContextEngine.layeredGraphCache.get(corpus);
    if (cached !== undefined) return cached;
    const g = buildLayeredCodeGraph({ symbols: corpus.symbols, fileText: corpus.fileText });
    ContextEngine.layeredGraphCache.set(corpus, g);
    return g;
  }
}

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

/** 代码停用词（PRF 扩展与重排的内容词筛选共用；表本身见 `ContentStopWords`）。 */

/**
 * 第二段重排器（打磨第二批 P1）。模块内单例：其内部只持「按语料 WeakMap 缓存」的词法视图，
 * **不导出**，故不构成跨模块可变的全局状态；同一进程内多语料互不干扰。
 */
const fileReranker = new FileReranker();

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
  /**
   * BM25 打分参数 `k1`（词频饱和）覆盖；缺省用 `Bm25Index` 默认 1.5。
   * 索引（df / 文档长度）与 k1/b 无关，故此值仅决定两索引的构造期默认；
   * 逐次调参扫描可直接用 `query` 的 search 期覆盖，无需重建语料。
   */
  readonly bm25K1?: number;
  /** BM25 打分参数 `b`（长度归一化）覆盖；缺省用 `Bm25Index` 默认 0.75。 */
  readonly bm25B?: number;
}

/** 索引某个目录下的源码，构建符号级与文件级双 BM25 索引。 */
export function indexCorpus(root: string, opts: IndexOptions = {}): IndexedCorpus {
  // 索引侧与查询侧必须同用一套分词，否则两侧变体集不相交，归并反而掉召回。
  const tk = opts.morph === false ? tokenize : tokenizeExpanded;
  // light 模式：跳过三项重型索引（仅在全量基准里 light:false 才开启）。
  const light = opts.light === true;
  const files: string[] = [];
  ContextEngine.walk(root, root, files);
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

  // exactOptionalPropertyTypes：仅装配显式提供的参数，缺省交由 Bm25Index 自身默认（1.5 / 0.75）。
  const bm25Init = {
    ...(opts.bm25K1 !== undefined ? { k1: opts.bm25K1 } : {}),
    ...(opts.bm25B !== undefined ? { b: opts.bm25B } : {}),
  };
  const symbolIndex = new Bm25Index(bm25Init);
  symbolIndex.addDocuments(symbolDocs);
  const fileIndex = new Bm25Index(bm25Init);
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
  /** 命中的文件（第一段按文件 BM25 排序；开启 `rerank` 时为其上的第二段重排结果）。 */
  readonly files: readonly string[];
}

/**
 * 检索式上下文（混合打分版）：
 * 每个文件的得分 = max(文件BM25分, 0.7 × 该文件内最强符号BM25分)。
 * 这样既保留文件级语义，又能把「文件级弱命中但含强相关符号」的文件（如 registerTool）
 * 捞回 Top-K，并在固定文件数上限内给出紧凑上下文——召回与压缩兼得。
 *
 * `opts.rerank: true` 时在上述第一段之后追加**第二段零依赖词法精排**
 * （见 {@link FileReranker}）：按「符号名 IDF 加权覆盖率」重排候选池，取 Top-K。
 * 该阶段只重排已入池文件，不新增候选，故不引入常量偏置。
 *
 * **历史死参数已移除（2026-09-16）**：签名原为 `query(corpus, q, k = 20, opts)`，
 * 但函数体**从不读取 `k`**——第一段候选数由下方固定候选上限（符号 60 / 文件 20）承担，
 * 文件预算由 `opts.fileK` 决定。调用方（生产 `RepoMapContextEngine` 传
 * `BM25_ONLY_CANDIDATES`=20、单测传 14/20）的取值一直被静默丢弃。因该参数无任何
 * 实际效果，直接移除**不改变行为**；把「候选数」重新做成可配置旋钮需单独评测，不在此处顺手改。
 */

export function query(
  corpus: IndexedCorpus,
  q: string,
  opts: {
    prf?: boolean;
    graph?: boolean;
    lsa?: boolean;
    layered?: boolean;
    fileK?: number;
    symK?: number;
    /** BM25 `k1` 的打分期覆盖（调参扫描用）；缺省用索引构造期取值。 */
    bm25K1?: number;
    /** BM25 `b` 的打分期覆盖（调参扫描用）；缺省用索引构造期取值。 */
    bm25B?: number;
    /**
     * 第二段重排（零依赖词法精排，见 `FileReranker`）。默认 **false**：
     * `query()` 的既有调用方（基准脚本 / 单测，冻结过报告口径）零行为变更；
     * 生产入口 `RepoMapContextEngine.getRepoMapContext` 显式传 true。
     */
    rerank?: boolean;
    /**
     * 重排的头部地板个数（把第一段前 N 个候选钉在原位）。缺省交由 `FileReranker`
     * 按 `round(fileK / 3)` 决定（实测两档 fileK 下的最优点）。仅在 `rerank: true` 时生效。
     */
    rerankFloor?: number;
  } = {},
): QueryResult {
  // 图检索默认关闭：实测在本语料上净负面。
  // 根因（evals/rank-veto-retro.mjs 实测，已更正早期「收敛至近均匀」的错误解释）：
  // 图排序对查询不敏感——Top-14 跨查询重合度 0.936，而 BM25 仅 0.058，
  // 等于给每条查询塞同一批枢纽文件，构成常量偏置，挤掉真正相关的文件。
  // 保留模块与 graph:true 开关供稀疏高质量边/语义权重场景使用。
  const useGraph = opts.graph === true;
  // E4 深化：层化图软融合（第三路，非替换）。默认关，仅供评测开启；D6 第二关未达标前不破生产口径。
  const useLayered = opts.layered === true;
  // LSA 默认关闭：实测在「词形归并」之上叠加 LSA，召回无增益（67.0% 持平），
  // 但符号精确率从 25.5% 腰斩至 10.5%（潜语义扩展引入噪声，挤掉真相关符号）。
  // 模块保留（lsa:true 可开启），供后续改用更高秩/稀疏化后重新评估。
  const useLsa = opts.lsa === true;
  // 第二段重排（打磨第二批 P1）：默认 **false** —— 直接调用 `query()` 的调用方（基准 / 单测）
  // 行为逐字不变；生产入口 `RepoMapContextEngine.getRepoMapContext` 会显式传 true。
  // 这样既让生产拿到收益，又不会悄悄改写任何已冻结的评测报告口径。
  const useRerank = opts.rerank === true;
  const qk = corpus.morph ? tokenizeExpanded(q) : tokenize(q);
  const FILE_K = opts.fileK ?? 14;
  const SYM_K = opts.symK ?? 30;
  // 打分期 BM25 参数覆盖（调参扫描）：索引与 k1/b 无关，故同一语料可零成本重打分。
  const bm25Args = {
    ...(opts.bm25K1 !== undefined ? { k1: opts.bm25K1 } : {}),
    ...(opts.bm25B !== undefined ? { b: opts.bm25B } : {}),
  };
  let bm25SymHits = [...corpus.symbolIndex.search(qk, 60, bm25Args)];
  let fileHits = [...corpus.fileIndex.search(qk, 20, bm25Args)];

  // 伪相关反馈（PRF / RM3 风格查询扩展）：突破纯词法召回天花板。零依赖、可测。
  // 实现要点（经 evals/recall-precision.mjs 实测校准，复刻该脚本的获胜配方）：
  //  - 取首轮 Top-R 文件（R=20，与基准脚本一致）作为反馈集；
  //  - 反馈集内 TF·IDF 加权选 Top-E 扩展词（E=6——太多引入噪声稀释头部）；
  //  - **重排（替换）而非并集**：扩展查询直接重跑 BM25、取新 Top-K 重排序，
  //    避免噪声候选挤掉真相关文件（朴素并集会把泛化词命中的文件顶进头部，实测 hitRate 39%→9% 崩塌）。
  //  IDF 用语料级 docFreq（按 corpus 缓存，避免每次查询重建）。
  if (opts.prf) {
    const df = docFreqOf(corpus);
    const N = corpus.files.length;
    const topFiles = fileHits
      .slice(0, 20)
      .map((h) => corpus.files[h.id]?.rel)
      .filter((r): r is string => r !== undefined);
    const fb = new Map<string, number>();
    for (const rel of topFiles) {
      const text = corpus.fileText.get(rel);
      if (text === undefined) continue;
      const tf = new Map<string, number>();
      for (const t of tokenizeExpanded(text)) {
        if (!ContentStopWords.isContent(t)) continue;
        tf.set(t, (tf.get(t) ?? 0) + 1);
      }
      const len = Math.max(
        1,
        [...tf.values()].reduce((a, b) => a + b, 0),
      );
      for (const [t, c] of tf) {
        const d = df.get(t) ?? 0;
        const idf = Math.log((N - d + 0.5) / (d + 0.5) + 1);
        fb.set(t, (fb.get(t) ?? 0) + (c / len) * idf);
      }
    }
    const qTok = new Set(tokenizeExpanded(q));
    const extra = [...fb.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map((e) => e[0])
      .filter((t) => !qTok.has(t));
    if (extra.length > 0) {
      const eqk = tokenizeExpanded(`${q} ${extra.join(' ')}`);
      // 重排：扩展查询重跑 BM25，直接替换候选（重排序由 BM25 分数决定），不并集。
      bm25SymHits = [...corpus.symbolIndex.search(eqk, 60, bm25Args)];
      fileHits = [...corpus.fileIndex.search(eqk, 20, bm25Args)];
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
    for (let i = 0; i < finalScores.length; i++) fmax = Math.max(fmax, at(finalScores, i));
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

  // E4 深化：层化图作为第三路软融合（非替换），保留文件 BM25 地板。
  // 根因（evals/layered-recall-ab.mjs 实测）：层化图此前作「替换」BM25 用，丢掉整文件
  // 词法命中信号 → −9.1pp。改为把图扩散分并入 fileScore 的 max，图只负责「捞回靠关联符号
  // 但无词法命中」的文件，文件 BM25 始终为地板项（绝不被静默丢弃）。
  const layeredFileScore = new Map<string, number>();
  if (useLayered) {
    const lg = ContextEngine.getLayeredGraph(corpus);
    const lscores = propagate(lg, seed, 4, 0.85);
    let lmax = 0;
    for (let i = 0; i < lscores.length; i += 1) lmax = Math.max(lmax, lscores[i] ?? 0);
    const linv = lmax > 0 ? 1 / lmax : 0;
    for (let i = 0; i < lscores.length; i += 1) {
      const v = (lscores[i] ?? 0) * linv;
      if (v <= 0) continue;
      const s = corpus.symbols[i];
      if (s === undefined) continue;
      symIdSet.add(i);
      const cur = layeredFileScore.get(s.file) ?? 0;
      if (v > cur) layeredFileScore.set(s.file, v);
    }
  }

  // 文件混合分：max(文件BM25, 0.7×符号BM25分, 0.5×层化图分)。
  const fileScore = new Map<string, number>();
  for (const h of fileHits) {
    const f = corpus.files[h.id];
    if (f === undefined) continue;
    const sym = bestSymbolScore.get(f.rel) ?? 0;
    const lay = layeredFileScore.get(f.rel) ?? 0;
    fileScore.set(f.rel, Math.max(h.score, 0.7 * sym, 0.5 * lay));
  }
  for (const [file, sym] of bestSymbolScore) {
    if (!fileScore.has(file)) fileScore.set(file, 0.7 * sym);
  }
  for (const [file, lay] of layeredFileScore) {
    if (!fileScore.has(file)) fileScore.set(file, 0.5 * lay);
  }
  // 第一段候选（**完整** fileScore，不按 FILE_K 截断）：候选池已由「BM25 文件路 ∪ 符号路映射回的文件」
  // 构成——实测该池在真实语料上已饱和（继续放大池子上界，召回 0 增益），故**不另起候选源**
  // （新候选源若与查询不敏感即构成常量偏置，见 `rankVetoEvaluator`）。
  const candidateFiles = [...fileScore.entries()].sort((a, b) => b[1] - a[1]).map(([rel]) => rel);
  // 第二段：重排（默认关；见上方 useRerank）。重排只重排入池文件，不新增/删除候选。
  const rankedFiles = useRerank
    ? [
        ...fileReranker.rerank({
          corpus,
          query: q,
          candidates: candidateFiles,
          fileK: FILE_K,
          ...(opts.rerankFloor !== undefined ? { floor: opts.rerankFloor } : {}),
        }).files,
      ]
    : candidateFiles.slice(0, FILE_K);

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

/**
 * 语料级文档频率（DF）缓存：PRF 扩展词的 IDF 加权需要语料级 df，按 corpus 缓存避免每次查询重建。
 * 用 WeakMap 让 corpus 被 GC 时自动释放，不泄漏。
 *
 * @param corpus 已索引语料（含 per-file 全文 `fileText`）
 * @returns 词 → 出现该词的文档数（DF）的映射，按 corpus 单例缓存
 */
const DF_CACHE = new WeakMap<IndexedCorpus, Map<string, number>>();
function docFreqOf(corpus: IndexedCorpus): Map<string, number> {
  const cached = DF_CACHE.get(corpus);
  if (cached !== undefined) return cached;
  const df = new Map<string, number>();
  for (const text of corpus.fileText.values()) {
    const seen = new Set(tokenizeExpanded(text));
    for (const t of seen) df.set(t, (df.get(t) ?? 0) + 1);
  }
  DF_CACHE.set(corpus, df);
  return df;
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
