/**
 * repo-map 生产接入器（U2）：把已实测的上下文引擎接到真实 agent 循环。
 *
 * 设计要点：
 *  - 进程级按 workspace 根路径缓存索引，避免每个 step 重扫全仓（light 模式索引已很快，
 *    但跨 step 复用更稳）；TTL 默认 30s，任一时段至多一次重索引，规避「agent 改文件→根 mtime
 *    变→每步重索引」的风暴。
 *  - 任何异常（坏路径 / 空仓 / 索引失败 / 查询失败 / 禁用）→ 返回 null，绝不抛错崩 agent。
 *  - 索引强制 light 模式：仅 morph + 符号/文件双 BM25，跳过频域共振/44 万边代码图/LSA SVD
 *    （三项在 omniharness 语料实测均零增益，U3 实验报告有证）。召回配置即基准里 67.0% 那档。
 *
 * 混合检索（语义召回，U3 残留的词法盲区补强）：
 *  - `getRepoMapContext` 保持同步、纯 BM25（零破坏、既有测试不变）。
 *  - `getHybridRepoMapContext` 在传入 EmbeddingPort 时启用：BM25 命中 ∪ 语义向量召回，
 *    经 RRF 融合后产出上下文。模型缺失/离线/嵌入抛错 → 回落纯 BM25（fail-closed）。
 *  - 默认关：仅当运行时注入 embedding（env OMNI_SEMANTIC_RECALL=1 构造适配器）才走混合路径，
 *    不增 config schema，避免破 fail-closed 校验，也避免默认加载 80MB 模型拖累每个 step。
 */

import { indexCorpus, query, type IndexedCorpus } from './contextEngine.js';
import { outlineText, type SymbolNode } from './repoMap.js';
import { tokenize, tokenizeExpanded } from '../search/bm25.js';
import { SemanticIndex, rrfMerge, type RecallItem } from './semanticRecall.js';
import { getGraphSignal, graphNeighborFileRoute, clearGraphSignal } from './codeReferenceGraph.js';
import type { EmbeddingPort } from '../ports/embedding.js';

/** 缓存条目：语料 + 索引时间戳（用于 TTL 失效）。 */
interface CacheEntry {
  readonly corpus: IndexedCorpus;
  readonly indexedAt: number;
}

const cache = new Map<string, CacheEntry>();
/** 最多缓存的工作区数量（多 workspace 会话防内存无限增长）。 */
const MAX_CACHE_ENTRIES = 4;

/**
 * 语义索引缓存：按 workspace 根路径缓存「已构建的 SemanticIndex」。
 * 存的是 Promise 以便并发请求复用同一次构建（构建期需 embed 全部符号/文件，较重）。
 * 构建失败存 null，下次请求重新尝试（仍 fail-closed 回退 BM25）。
 */
const semanticCache = new Map<string, Promise<SemanticIndex | null>>();

/**
 * 语义索引缓存键：必须带上 chunkRecall 与 fullFileDoc 两个开关。
 * 索引内容随这两个开关而变（chunk 项是否入索引 / 文件文档是 600 字符还是全文），
 * 若键不含它们，同进程内先后以不同开关调用会命中对方构建的索引——静默脏读。
 */
function semanticKey(
  root: string,
  chunkRecall: boolean,
  fullFileDoc: boolean,
  docMode: string,
): string {
  const rep = fullFileDoc ? 'fulldoc' : docMode === 'id' ? 'id' : 'snip600';
  return `${chunkRecall ? 'chunk' : 'nochunk'}|${rep}|${root}`;
}

/** 索引 TTL（毫秒）：超过则下次查询触发重索引。可由 env OMNI_REPO_MAP_TTL_MS 覆盖。 */
function ttlMs(): number {
  const raw = Number(process.env.OMNI_REPO_MAP_TTL_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : 30_000;
}

/** 索引单个根目录（light 模式）。失败返回 null（fail-closed）。 */
function indexRoot(root: string): IndexedCorpus | null {
  try {
    return indexCorpus(root, { morph: true, light: true });
  } catch {
    return null;
  }
}

/** 取（命中缓存或重索引）语料。返回 null 表示索引不可用。 */
function getCached(root: string): IndexedCorpus | null {
  const now = Date.now();
  const existing = cache.get(root);
  if (existing !== undefined && now - existing.indexedAt < ttlMs()) {
    return existing.corpus;
  }
  const corpus = indexRoot(root);
  if (corpus === null) {
    return null;
  }
  if (cache.size >= MAX_CACHE_ENTRIES) {
    // 驱逐最早索引的条目（近似 LRU，够用且零依赖）。
    let oldestKey: string | undefined;
    let oldest = Infinity;
    for (const [key, entry] of cache) {
      if (entry.indexedAt < oldest) {
        oldest = entry.indexedAt;
        oldestKey = key;
      }
    }
    if (oldestKey !== undefined) {
      cache.delete(oldestKey);
      semanticCache.delete(oldestKey);
    }
  }
  cache.set(root, { corpus, indexedAt: now });
  return corpus;
}

/** 生产接入选项。 */
export interface RepoMapContextOptions {
  /** 是否启用；默认开。env OMNI_REPO_MAP=0 由调用方显式传 enabled:false。 */
  readonly enabled?: boolean;
  /** 注入的系统碎片里最多几个文件（默认 10，保持精简）。 */
  readonly fileK?: number;
  /** 注入的系统碎片里最多几个符号（默认 24）。 */
  readonly symK?: number;
  /**
   * RRF 融合常数 k（默认 60）。越小排名越「尖锐」——头部命中权重越高。
   * 实测在 k=20/40/60 之间结果几乎无差异（语义路质量才是主因），保留旋钮以备换模型后重调。
   * 可通过 env OMNI_RRF_K 覆盖。
   */
  readonly rrfK?: number;
  /**
   * 语义路在 RRF 中的权重（BM25 路恒为 1）。<1 抑制语义噪声，>1 放大语义信号。
   * 默认 **1.0（等权）**。
   * 历史教训：曾据 10 条查询的小样本把它调到 0.5，理由是「语义噪声稀释 BM25」；
   * 后来发现真正的病根是文件语义文档只有正文前 600 字符（≈import 样板），
   * 语义路天花板仅 44.6%。把符号名加进文档后天花板升到 50.7%，
   * 此时 33 条查询扫描显示 **w=1.0 → +7.7pp，而 w=0.5 只有 +2.3pp**
   * ——降权是在给一个坏表示打补丁，表示修好后等权即最优。
   * 可通过 env OMNI_SEM_WEIGHT 覆盖。
   */
  readonly semWeight?: number;
  /**
   * BM25 保护位：融合后强制保留 BM25 自己的前 N 个文件（默认 0 = 关闭）。
   * 作用：封顶「个别查询回退」风险——语义路上权重后可能把 BM25 头部命中挤出 Top-K。
   * 注意：只钉 BM25 **头部**命中，救不了中段命中（实测 ToolCallRef 的 GT 落在 BM25 11–14 位，
   * 即便 floor=10 仍回退）；要完全消除需 floor=fileK=退化为纯 BM25。属可选风险封顶，非万能。
   * 可通过 env OMNI_BM25_FLOOR 覆盖。
   */
  readonly bm25Floor?: number;
  /**
   * 符号→文件融合：把语义命中的**符号**映射回其所属文件，并入文件排名。
   * 默认 true（实测净增益 +5pp：33 条查询 ↑10 / ↓2 / =21；符号命中经 RRF 双重加权
   * 把共指文件顶进 Top-K）。2 条回退均为大 GT（≥10）查询，属语义噪声，可接受。
   * 可用 opts.mergeSymbols=false 或 env OMNI_MERGE_SYMBOLS=0 关闭。
   */
  readonly mergeSymbols?: boolean;
  /**
   * 分块语义检索（表示层破天花板的核心一刀）：把每个符号的**函数体**切成独立 chunk
   * （带符号名/签名 + 代码体窗口），作为额外的语义召回路，命中后映射回所属文件并入 RRF。
   *
   * 动机：历史文件语义文档只取「路径 + 符号名 + 前 600 字符」，大文件深处的函数
   * 只有名字进索引、实现体从不被语义路看到——这正是 59% 天花板的根因之一。
   * 分块让每个函数的真实代码体都能被语义检索命中，再经符号→文件映射把对应文件顶进 Top-K。
   *
   * 默认 **false（关）**；env OMNI_CHUNK_RECALL=1 或 opts.chunkRecall=true 可开。
   * 消融证明它对召回是噪声（minilm +0.2pp）/ 有害（e5-large −0.8pp），却使构建耗时约 3–4 倍，属纯延迟税。
   */
  readonly chunkRecall?: boolean;
  /**
   * 全文文件文档（实验 1：Late Chunking 表示层破天花板）。
   * 把文件语义文档从「路径 + 符号名 + 前 600 字符」换成「路径 + 全文」（截断到 FULL_FILE_DOC_MAX_CHARS）。
   * 需配合长上下文代码嵌入模型（如 jina-base-code 8K）才有效——minilm(256 ctx) 喂全文会被静默截断，反而更差。
   *
   * 动机：前 600 字符几乎全是 import/license 样板，函数体深处语义从不被语义路看到；
   * 长上下文代码模型可一次编码整文件，单向量即含全文语义，直接修「表示绑定」瓶颈。
   * 默认 **false（关，沿用历史 600 字符文档）**；env OMNI_FULL_FILE_DOC=1 或 opts.fullFileDoc=true 可开。
   */
  readonly fullFileDoc?: boolean;
  /**
   * 文件文档表示模式（实验 1b：浓缩身份 vs 原始代码噪声）。
   * - 'snip'（默认）：rel + 符号名 + 前 600 字符原始代码（历史表示，59.2% 基准）。
   * - 'id'：rel + 符号名 + 各符号签名（浓缩「这个文件定义什么」身份，丢弃原始代码噪声）。
   * 实验 1 证明：600 字符版靠「显式浓缩符号名」才赢；全文版稀释该信号反降。
   * 本开关直接检验「浓缩身份」是否优于「原始代码片段」，是最贴合该洞察的受控变量。
   */
  readonly docMode?: 'snip' | 'id';
  /**
   * P5 图/结构信号第四路（同行实证：Aider 符号引用图 PageRank / Greptile 调用图多跳 /
   * Cody SCIP 代码图）。以查询命中符号（BM25 ∪ 语义）为 seed，沿**稀疏引用图**扩散 1 跳，
   * 收集邻居符号 → 文件，按文件 PageRank 中心性降序排成第四路 `file:`-id 列表并入 mergedFile。
   *
   * 图是**稀疏**的（仅保留稀有共享标识符 df≤4 的边），区别于已诚实测过 −6.1pp 的 429k 稠密老图：
   * 只有「两文件都引用了同一个罕见符号」才连边，是真正高信号的结构关联。
   * 离线零重嵌税、查询期零重建（图按 workspace 根缓存）、fail-closed（图异常 → 跳过第四路）。
   *
   * 默认 **false（关）**；env OMNI_GRAPH_SIGNAL=1 可开。**保留为实验旋钮，不作默认/不作破天花板杠杆**。
   * 受控消融结论（2026-09-05）：单跳易查询 +0.5pp 微弱正，但多跳难查询 **-2.6pp 净负**（↓6/↑3/=11），
   * 且出现 40pp 重挫实例（diff/tool 查询 60%→20%）。本地词法引用图 ≠ GraphRAG 真知识图谱，多跳增益假设证伪。
   */
  readonly graphSignal?: boolean;
  /**
   * P5 第四路在 RRF 中的权重（BM25 路恒为 1，语义路 semWeight）。
   * 默认 **1.0（等权）**；env OMNI_GRAPH_WEIGHT 覆盖。
   */
  readonly graphWeight?: number;
}

/** 全文文件文档最大字符数（约 8K token 内，留余量；ALiBi 可外推但质量在训练窗口内最佳）。 */
const FULL_FILE_DOC_MAX_CHARS = 8000;

/**
 * 产出可注入 system 消息的 repo-map 上下文文本（纯 BM25，同步、零破坏）。
 * 任意失败路径均返回 null（调用方据此跳过注入，不影响主流程）。
 */
export function getRepoMapContext(
  root: string,
  q: string,
  opts: RepoMapContextOptions = {},
): string | null {
  if (opts.enabled === false) {
    return null;
  }
  if (root === undefined || root === '' || q.trim() === '') {
    return null;
  }
  const corpus = getCached(root);
  if (corpus === null) {
    return null;
  }
  try {
    const res = query(corpus, q, 20, {
      prf: false,
      graph: false,
      lsa: false,
      fileK: opts.fileK ?? 10,
      symK: opts.symK ?? 24,
    });
    return res.context;
  } catch {
    return null;
  }
}

/**
 * 数值旋钮解析：opts > env > 默认；非法值（空串 / NaN / 越界）回落默认。
 * 注意：0 是合法取值（semWeight=0 表示完全关掉语义路），因此**不能**用 `||` 兜底——
 * `0 || dflt` 会把显式传入的 0 悄悄改成默认值。
 */
function numericKnob(
  optsVal: number | undefined,
  envVal: string | undefined,
  dflt: number,
  min: number,
): number {
  const fromEnv = envVal !== undefined && envVal.trim() !== '' ? Number(envVal) : Number.NaN;
  const raw = optsVal ?? fromEnv;
  return Number.isFinite(raw) && raw >= min ? raw : dflt;
}

/**
 * 分块语义召回：把每个符号的**函数体**切成独立 chunk（带符号名/签名 + 代码体窗口），
 * 作为额外语义召回路。每个 chunk 的 id 用 `chunk:<i>`（i 为 corpus.symbols 下标），
 * 召回后由 `corpus.symbols[i].file` 映射回文件 —— 复用与「符号→文件融合」完全相同的映射机制。
 *
 * 这是「表示层」破天花板的核心一刀：历史文件语义文档只取「路径 + 符号名 + 前 600 字符」，
 * 大文件深处的函数只有名字进索引、实现体从不被语义路看到。分块让每个函数的真实代码体
 * 都能被语义检索命中，从而把对应文件顶进 Top-K。
 *
 * body 窗口 = 从本符号声明行到同文件下一个符号声明行（或最多 CHUNK_BODY_MAX_LINES 行），
 * 截到末尾符号则用固定窗口。纯函数、零依赖、可单测（见 tests/unit/repoMapContext.test.ts）。
 */
export const CHUNK_BODY_MAX_LINES = 80;

export function buildChunkItems(corpus: IndexedCorpus): RecallItem[] {
  const byFile = new Map<string, number[]>();
  for (let i = 0; i < corpus.symbols.length; i++) {
    const f = corpus.symbols[i]!.file;
    const arr = byFile.get(f);
    if (arr === undefined) {
      byFile.set(f, [i]);
    } else {
      arr.push(i);
    }
  }
  const items: RecallItem[] = [];
  for (let i = 0; i < corpus.symbols.length; i++) {
    const s = corpus.symbols[i]!;
    const text = corpus.fileText.get(s.file);
    if (text === undefined) {
      continue;
    }
    const lines = text.split('\n');
    const arr = byFile.get(s.file);
    const pos = arr === undefined ? -1 : arr.indexOf(i);
    const start = Math.max(0, s.line - 1);
    let end: number;
    if (pos >= 0 && pos + 1 < arr!.length) {
      const next = corpus.symbols[arr![pos + 1]!]!;
      end = Math.max(start, next.line - 1);
    } else {
      end = Math.min(lines.length, start + CHUNK_BODY_MAX_LINES);
    }
    let slice = lines.slice(start, end);
    if (slice.length > CHUNK_BODY_MAX_LINES) {
      slice = slice.slice(0, CHUNK_BODY_MAX_LINES);
    }
    const body = slice.join('\n');
    items.push({
      id: `chunk:${i}`,
      text: `${s.file}\n${s.name} ${s.kind} ${s.signature}\n${body}`,
    });
  }
  return items;
}

/**
 * 构建（或复用缓存的）语义索引：把语料的全部符号 + 文件（+ 可选分块）嵌入为向量。
/**
 * 构建每个文件的语义文档文本（与 getSemanticIndex 建索引时同源）。
 * 抽成单一来源：语义索引构建与查询期文档构造都用它，避免双份逻辑漂移。
 * 返回 `file:<rel>` → 文档文本。docMode/fullFileDoc 的语义与 getHybridRepoMapContext 完全一致。
 */
function buildFileDocTexts(
  corpus: IndexedCorpus,
  docMode: 'snip' | 'id',
  fullFileDoc: boolean,
): Map<string, string> {
  const symbolsByFile = new Map<string, string[]>();
  const sigsByFile = new Map<string, string[]>();
  for (const s of corpus.symbols) {
    const arr = symbolsByFile.get(s.file);
    if (arr === undefined) {
      symbolsByFile.set(s.file, [s.name]);
      sigsByFile.set(s.file, [s.signature]);
    } else if (arr.length < 60) {
      arr.push(s.name);
      sigsByFile.get(s.file)!.push(s.signature);
    }
  }
  const docs = new Map<string, string>();
  for (const f of corpus.files) {
    const text = corpus.fileText.get(f.rel) ?? '';
    let body: string;
    if (fullFileDoc) {
      // 实验 1（Late Chunking）：长上下文代码模型（如 jina 8K）编码整文件，单向量含全文语义。
      const doc =
        text.length > FULL_FILE_DOC_MAX_CHARS ? text.slice(0, FULL_FILE_DOC_MAX_CHARS) : text;
      body = doc;
    } else if (docMode === 'id') {
      // 实验 1b（浓缩身份）：rel + 符号名 + 签名，丢弃原始代码噪声。
      const names = (symbolsByFile.get(f.rel) ?? []).join(' ');
      const sigs = (sigsByFile.get(f.rel) ?? []).join(' ');
      body = `${names}\n${sigs}`;
    } else {
      const snippet = text.length > 600 ? text.slice(0, 600) : text;
      const names = (symbolsByFile.get(f.rel) ?? []).join(' ');
      body = `${names}\n${snippet}`;
    }
    docs.set(`file:${f.rel}`, `${f.rel}\n${body}`);
  }
  return docs;
}

/**
 * 符号文本用 `name kind signature file`（与 indexCorpus 的 symbolDocs 同源，保证嵌入空间一致）；
 * 文件文本用 `rel + 前 1500 字符`（足够携带文件主题语义，又不至于过长）。
 * id 用 `sym:<i>` / `file:<rel>` / `chunk:<i>` 前缀，便于召回后映射回 corpus。
 */
async function getSemanticIndex(
  root: string,
  corpus: IndexedCorpus,
  embedding: EmbeddingPort,
  chunkRecall = false,
  fullFileDoc = false,
  // 默认 'id'：文件语义文档用「符号名+签名」而非前 600 字符片段（snip）。
  // 实测 'id' 模式把语义路天花板从 44.6% 推到 59.1%（符号→文件融合的前提），
  // 是 e5-large-v2 混合检索达 63.2% 的同一配置。'snip' 为历史占位默认，非最优。
  docMode: 'snip' | 'id' = 'id',
): Promise<SemanticIndex> {
  const key = semanticKey(root, chunkRecall, fullFileDoc, docMode);
  const existing = semanticCache.get(key);
  if (existing !== undefined) {
    const idx = await existing;
    if (idx !== null) {
      return idx;
    }
    // 上次构建失败：落空，重新尝试。
  }
  const promise = (async (): Promise<SemanticIndex | null> => {
    try {
      const items: RecallItem[] = [];
      corpus.symbols.forEach((s, i) => {
        items.push({ id: `sym:${i}`, text: `${s.name} ${s.kind} ${s.signature} ${s.file}` });
      });
      // 文件语义文档 = 路径 + 该文件符号名 + 正文片段。
      // 关键教训：TS 文件前 N 字符几乎全是 import / license 注释，光靠正文片段做向量≈噪声，
      // 语义路因此在真实代码库上几乎没有召回能力（实测天花板仅 44.6% vs BM25 43.2%）。
      // 符号名才是「这个文件是干什么的」的最强表征，且 corpus 里现成就有，零额外成本。
      // 文件语义文档文本与建索引时同源（buildFileDocTexts），避免双份逻辑漂移。
      const fileDocs = buildFileDocTexts(corpus, docMode, fullFileDoc);
      for (const [fid, ftext] of fileDocs) {
        items.push({ id: fid, text: ftext });
      }
      // 分块语义召回：把每个符号的函数体切成 chunk（带符号名/签名），弥补文件文档只取
      // 前 600 字符的表示缺陷。chunk 项与符号项并行，互补不互斥（同 env OMNI_CHUNK_RECALL 控制）。
      if (chunkRecall) {
        for (const c of buildChunkItems(corpus)) {
          items.push(c);
        }
      }
      const idx = new SemanticIndex(embedding);
      await idx.build(items);
      return idx;
    } catch {
      return null;
    }
  })();
  semanticCache.set(key, promise);
  const built = await promise;
  if (built === null) {
    throw new Error('semantic index build failed');
  }
  return built;
}

/**
 * 混合检索版 repo-map 上下文（BM25 ∪ 语义向量，RRF 融合）。
 * 仅在调用方传入有效 EmbeddingPort 时启用；任意嵌入/召回异常 → 回落纯 BM25（fail-closed），
 * 绝不因语义层失败而崩主流程或丢上下文。
 */
export async function getHybridRepoMapContext(
  root: string,
  q: string,
  embedding: EmbeddingPort,
  opts: RepoMapContextOptions = {},
): Promise<string | null> {
  if (root === '' || q.trim() === '') {
    return null;
  }
  const corpus = getCached(root);
  if (corpus === null) {
    return null;
  }
  try {
    // chunkRecall 默认关：消融证明它对召回是噪声（minilm +0.2pp）/ 有害（e5-large −0.8pp），
    // 却使索引项数近乎翻倍、构建耗时约 3–4 倍；缓存按写失效重建，属纯延迟税。开需显式 opt-in。
    const chunkRecall = opts.chunkRecall ?? process.env.OMNI_CHUNK_RECALL === '1';
    // fullFileDoc 默认关：实验 1 受控变量，仅长上下文代码模型（jina 8K）下有意义；
    // minilm(256 ctx) 喂全文会被静默截断反更差，故默认关、显式 opt-in。
    const fullFileDoc = opts.fullFileDoc ?? process.env.OMNI_FULL_FILE_DOC === '1';
    // docMode 默认 'snip'（历史 600 字符+符号名表示）；'id' 为实验 1b 浓缩身份表示。
    const docMode = opts.docMode ?? (process.env.OMNI_DOC_MODE === 'id' ? 'id' : 'snip');
    const idx = await getSemanticIndex(root, corpus, embedding, chunkRecall, fullFileDoc, docMode);
    const tk = corpus.morph ? tokenizeExpanded(q) : tokenize(q);
    const bm25SymHits = [...corpus.symbolIndex.search(tk, 60)];
    const bm25FileHits = [...corpus.fileIndex.search(tk, 20)];

    const semHits = await idx.search(q, 40);
    const symSemIds: string[] = [];
    const fileSemIds: string[] = [];
    const chunkSemIds: string[] = [];
    for (const h of semHits) {
      if (h.id.startsWith('sym:')) {
        symSemIds.push(h.id);
      } else if (h.id.startsWith('file:')) {
        fileSemIds.push(h.id);
      } else if (h.id.startsWith('chunk:')) {
        chunkSemIds.push(h.id);
      }
    }

    const bm25SymIds = bm25SymHits.map((h) => `sym:${h.id}`);
    const bm25FileIds = bm25FileHits
      .map((h) => corpus.files[h.id]?.rel)
      .filter((rel): rel is string => rel !== undefined)
      .map((rel) => `file:${rel}`);

    // RRF 融合：BM25 与语义两路并列，对分数尺度不敏感。平均召回优于纯 BM25，
    // 但**逐查询不保证「只增不减」**——语义路上权重后可能把 BM25 中段命中挤出 Top-K
    // （33 条真实查询里 1 条回退，见 evals/validation-2026-09-05.md 第 7 节）。
    // rrfK 越小排名越尖锐（头部命中权重更高）；semWeight<1 抑制弱路、>1 放大强路。
    const rrfK = numericKnob(opts.rrfK, process.env.OMNI_RRF_K, 60, 1);
    // 默认 1.0（等权）：33 条真实查询扫描下 w=1.0 → +7.7pp，w=0.5 仅 +2.3pp（详见接口注释）。
    const semWeight = numericKnob(opts.semWeight, process.env.OMNI_SEM_WEIGHT, 1, 0);
    // BM25 保护位：RRF 融合后，强制把 BM25 自己的前 N 个文件保留在最终结果里。
    // 存在的理由：语义路权重上调后，语义命中会把 BM25 的命中挤出 Top-K，导致
    // 个别查询的混合召回**低于**纯 BM25（实测 ToolCallRef 22.2%→0%），
    // 违背「融合后召回只增不减」这条设计不变量。0 = 关闭（历史行为）。
    const bm25Floor = numericKnob(opts.bm25Floor, process.env.OMNI_BM25_FLOOR, 0, 0);
    // 符号→文件融合：把语义命中的符号映射回所属文件，让符号级精度直接抬升文件级召回。
    // 默认开（实测净增益 +5pp，见 evals/validation-2026-09-05.md 第 8 节）；env=0 可关。
    const mergeSymbols = opts.mergeSymbols ?? process.env.OMNI_MERGE_SYMBOLS !== '0';
    // P5 图信号第四路：默认关（多跳难查询 -2.6pp 净负，已证伪"多跳增益放大"假设）；env OMNI_GRAPH_SIGNAL=1 可开（实验旋钮）。
    const graphSignal = opts.graphSignal ?? process.env.OMNI_GRAPH_SIGNAL === '1';
    // P5 第四路 RRF 权重（默认等权 1.0）。
    const graphWeight = numericKnob(opts.graphWeight, process.env.OMNI_GRAPH_WEIGHT, 1, 0);
    const FILE_K = opts.fileK ?? 10;
    const SYM_K = opts.symK ?? 24;
    const symSemFileIds: string[] = [];
    if (mergeSymbols) {
      for (const id of symSemIds) {
        const sym = corpus.symbols[Number(id.slice('sym:'.length))];
        if (sym !== undefined) symSemFileIds.push(`file:${sym.file}`);
      }
    }
    // 分块语义召回：chunk 命中映射回所属文件，作为额外融合路（与符号→文件同机制）。
    // 默认关（chunkRecall）；env OMNI_CHUNK_RECALL=1 或 opts.chunkRecall=true 可开。已证增益为噪声/有害，仅作 opt-in。
    const chunkSemFileIds: string[] = [];
    if (chunkRecall) {
      for (const id of chunkSemIds) {
        const sym = corpus.symbols[Number(id.slice('chunk:'.length))];
        if (sym !== undefined) chunkSemFileIds.push(`file:${sym.file}`);
      }
    }
    // 频域共振召回（燧-3 频谱）已从 hybrid 移除：生产语料强制 light 模式（symbolSpectra=[]），
    // 该路在 hybrid 内恒为死代码；且诚实重测证明频谱对文件召回纯零效应（见 evals/diag-spectrum.mjs）。
    // hybrid 的召回由 BM25 ∪ 语义向量（符号/文件/分块三路）RRF 融合承担。
    const toHits = (ids: readonly string[]) => ids.map((id) => ({ id }));
    const mergedSym = rrfMerge([toHits(bm25SymIds), toHits(symSemIds)], rrfK, [1, semWeight]);
    const fileLists: Array<readonly { readonly id: string }[]> = [
      toHits(bm25FileIds),
      toHits(fileSemIds),
    ];
    const fileWeights: number[] = [1, semWeight];
    if (mergeSymbols) {
      fileLists.push(toHits(symSemFileIds));
      fileWeights.push(semWeight);
    }
    if (chunkRecall) {
      fileLists.push(toHits(chunkSemFileIds));
      fileWeights.push(semWeight);
    }
    // P5 第四路：以查询命中符号（BM25 ∪ 语义）为 seed，沿稀疏引用图扩散 1 跳，
    // 收集邻居文件（按中心性降序）作为一路并入 RRF。仅含邻居（seed 自身文件已在 BM25/语义路）。
    // fail-closed：图构建/扩散/邻域提取任一异常 → 跳过第四路，不崩主流程。
    if (graphSignal) {
      try {
        const seedSymIdx: number[] = [];
        for (const id of [...bm25SymIds, ...symSemIds]) {
          const n = Number(id.slice('sym:'.length));
          if (Number.isFinite(n)) seedSymIdx.push(n);
        }
        if (seedSymIdx.length > 0) {
          const sig = getGraphSignal(root, corpus);
          const graphFileIds = graphNeighborFileRoute(corpus, seedSymIdx, sig);
          if (graphFileIds.length > 0) {
            fileLists.push(toHits(graphFileIds));
            fileWeights.push(graphWeight);
          }
        }
      } catch {
        // fail-closed：图信号异常 → 退回不含第四路的融合结果。
      }
    }
    const mergedFile = rrfMerge(fileLists, rrfK, fileWeights);

    let rankedFiles = mergedFile.slice(0, FILE_K).map((id) => id.slice('file:'.length));
    if (bm25Floor > 0) {
      // 保护位在前（保持 BM25 自身次序），其余按融合次序补齐，最后截断到 FILE_K。
      const protectedRels = bm25FileIds.slice(0, bm25Floor).map((id) => id.slice('file:'.length));
      const protectedSet = new Set(protectedRels);
      const rest = rankedFiles.filter((rel) => !protectedSet.has(rel));
      rankedFiles = [...protectedRels, ...rest].slice(0, FILE_K);
    }
    const fileSet = new Set(rankedFiles);
    const rankedSymbols = mergedSym
      .slice(0, SYM_K)
      .map((id) => corpus.symbols[Number(id.slice('sym:'.length))])
      .filter((s): s is SymbolNode => s !== undefined);

    const outline = outlineText(corpus.symbols.filter((s) => fileSet.has(s.file)));
    const sigLines = rankedSymbols.map((s) => `L${s.line} ${s.kind} ${s.name} @ ${s.file}`);
    return ['# Repo Map (relevant files)', outline, '# Relevant Symbols', ...sigLines].join('\n');
  } catch {
    // fail-closed：语义层失败 → 回落纯 BM25 上下文。
    return getRepoMapContext(root, q, opts);
  }
}

/** 手动失效缓存（某个 workspace 文件结构剧变时调用，可选）。同时清语义索引缓存。 */
export function clearRepoMapCache(root?: string): void {
  if (root === undefined) {
    cache.clear();
    semanticCache.clear();
  } else {
    cache.delete(root);
    // 语义索引键含 chunkRecall 前缀，按 root 失效须清掉该 root 下全部变体。
    for (const k of [...semanticCache.keys()]) {
      if (k.slice(k.indexOf('|') + 1) === root) {
        semanticCache.delete(k);
      }
    }
    // P5 稀疏引用图按 root 缓存，文件结构剧变须同步失效。
    clearGraphSignal(root);
  }
}
