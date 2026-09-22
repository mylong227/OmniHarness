/**
 * 零依赖 Okapi BM25 检索器（#M1 工具语义检索）。
 * 仅依赖标准 JS，用于工具 schema 的自然语言检索，无需引入任何 BM25 库。
 *
 * ## 倒排表（2026-09-22，性能收尾）
 *
 * `search` 原先对**每个查询词**遍历**每个文档的每个 token** 现算词频（`O(Q × Σ|doc|)`）：
 * 实测真实 `src/` 语料（563 文件 / 986,432 token）单次 `fileIndex.search` 为
 * **18.6 ms（1 命中词）～252 ms（22 命中词，中文查询）**，并按 token 数严格线性放大
 * （1M token/20 词 = 98.5 ms；配置上限 32 MiB 外推 ≈2.6 s/步），是 agent 每步固定开销的大头。
 * 现改为 `addDocuments` 期建「词项 → (docId, tf)」倒排表，`search` 只遍历查询词命中的 postings：
 * 同一组查询实测 **169×～985×**（235 ms → 0.24 ms），建索引一次性代价 +277 ms（file）。
 *
 * 行为等价性由三点构造保证，`tests/unit/bm25Index.test.ts` 以暴力实现逐位对拍钉住：
 * ① 命中集合相同（tf>0 ⇔ 该词项的 postings 含此 docId）；
 * ② 同一文档的累加顺序不变（查询词外层、docId 升序内层），故浮点结果逐位相同；
 * ③ df / 文档长度 / 平均长度口径未动，`idf()` 与 `documentFrequencyOf()` 保持对外同源。
 *
 * @maturity L1 — 主力召回；形态归并已破一层天花板（实测文件召回 67.0%）
 * @maturityEvidence tests/unit/toolSearch.test.ts
 */

import { at } from '../util/arrayAt.js';

/**
 * @beta
 * BM25 调参。
 */
export interface Bm25Options {
  readonly k1?: number;
  readonly b?: number;
}

/**
 * @beta
 * 单文档得分。
 */
export interface Bm25Hit {
  readonly id: number;
  readonly score: number;
}

/**
 * @beta
 * Okapi BM25 倒排索引检索器。
 * 文档以「已分词 token 数组」形式加入；查询同样传入 token 数组。
 */
export class Bm25Index {
  private readonly k1: number;
  private readonly b: number;
  private readonly documents: string[][] = [];
  private readonly documentFrequency = new Map<string, number>();
  /**
   * 倒排表：词项 → 该词项在哪些文档中出现、词频多少（`ids` 升序，与 `tfs` 一一对应）。
   *
   * 为什么需要：`search` 原先为算 tf 而重扫全部文档 token（见模块头「倒排表」节）。
   * 用两个并行数组而不是 `Array<{id,tf}>`，是为了避免每篇文档每个词项多分配一个对象
   * （本语料 98.6 万 token ⇒ 省下近百万次小对象分配）。
   */
  private readonly postings = new Map<string, { ids: number[]; tfs: number[] }>();
  /**
   * 已加入文档的 token 总数（跨批累加）。
   *
   * 为什么单列字段：`averageLength` 是 `Σ|doc| / N` 的口径，而**分批** `addDocuments` 时
   * 若只用「本批 total / 全部文档数」，平均长度会被算小（2026-09-22 由
   * `tests/unit/bm25Index.test.ts` 的「分批 = 单批」对拍暴露）。生产调用点目前均为单批，
   * 故该修复对既有行为零影响；但接口语义（可多次追加）此前是错的。
   */
  private totalTokens = 0;
  private averageLength = 0;

  public constructor(options: Bm25Options = {}) {
    this.k1 = options.k1 ?? 1.5;
    this.b = options.b ?? 0.75;
  }

  /** 批量加入已分词文档。
   * @returns 无返回值。
   */
  public addDocuments(documents: readonly (readonly string[])[]): void {
    for (const tokens of documents) {
      const docId = this.documents.length;
      this.documents.push([...tokens]);
      this.totalTokens += tokens.length;
      // 单趟统计本文件的 tf（同时得到 df：出现在本文件即计 1 次）。
      const termFrequency = new Map<string, number>();
      for (const term of tokens) {
        termFrequency.set(term, (termFrequency.get(term) ?? 0) + 1);
      }
      for (const [term, frequency] of termFrequency) {
        this.documentFrequency.set(term, (this.documentFrequency.get(term) ?? 0) + 1);
        const posting = this.postings.get(term);
        if (posting === undefined) {
          this.postings.set(term, { ids: [docId], tfs: [frequency] });
        } else {
          posting.ids.push(docId);
          posting.tfs.push(frequency);
        }
      }
    }
    this.averageLength = this.documents.length === 0 ? 0 : this.totalTokens / this.documents.length;
  }

  /**
   * 已加入的文档总数（IDF 的分母口径）。
   * @returns 文档数
   */
  public get documentCount(): number {
    return this.documents.length;
  }

  /**
   * 词项的文档频率（出现在多少个已加入文档中）。
   * 供外部消费方按其自身口径复用同一统计（如重排器的 IDF 加权），避免各自重复遍历。
   * @param term 词项
   * @returns 文档频率；未收录返回 0
   */
  public documentFrequencyOf(term: string): number {
    return this.documentFrequency.get(term) ?? 0;
  }

  /**
   * 词项的逆文档频率（`search` 打分使用的同一公式）。
   *
   * 公式：`ln(1 + (N − df + 0.5) / (df + 0.5))`。
   * 之所以公开：重排 / 评估等消费方需要与第一段**同源**的词权重，
   * 若各自按「自己的公式」计算会出现两套口径（历史坑：两侧 IDF 口径漂移导致加权不可比）。
   * @param term 词项
   * @returns IDF；词项未收录或索引为空时返回 0
   */
  public idf(term: string): number {
    const count = this.documents.length;
    if (count === 0) {
      return 0;
    }
    const df = this.documentFrequency.get(term);
    if (df === undefined) {
      return 0;
    }
    return Math.log(1 + (count - df + 0.5) / (df + 0.5));
  }

  /**
   * 检索：查询词（已分词）→ 降序得分，截断 limit。
   *
   * 索引（df / 文档长度）与 `k1`/`b` **无关**，故允许在 `search` 期覆盖打分参数，
   * 使同一份已建索引可零成本重打分（调参扫描 / 换场景复用），无需重建语料。
   * @param queryTokens 已分词查询词。
   * @param limit 返回条数上限（≤0 返回空）。
   * @param options 可选的 `k1` / `b` 覆盖；缺省用构造期取值。
   * @returns 按得分降序、截断至 limit 的命中列表（仅 score>0 者）。
   */
  public search(
    queryTokens: readonly string[],
    limit: number,
    options: Bm25Options = {},
  ): readonly Bm25Hit[] {
    const k1 = options.k1 ?? this.k1;
    const b = options.b ?? this.b;
    const count = this.documents.length;
    if (count === 0 || limit <= 0) {
      return [];
    }
    const scores = new Array<number>(count).fill(0);
    for (const term of queryTokens) {
      // IDF 统一走 `idf()`（与外部消费方同一公式，杜绝两套口径）。
      // 未收录词返回 0 ⇒ 与原先 `df === undefined → continue` 逐字等价。
      const idf = this.idf(term);
      if (idf <= 0) {
        continue;
      }
      const posting = this.postings.get(term);
      if (posting === undefined) {
        continue;
      }
      // 只遍历「含该词项」的文档（原实现此处遍历全部文档并逐篇重扫 token）。
      // ids 为 docId 升序 ⇒ 同一文档的跨词累加顺序与旧实现一致，浮点结果逐位相同。
      for (let p = 0; p < posting.ids.length; p += 1) {
        const docId = at(posting.ids, p);
        const frequency = at(posting.tfs, p);
        const doc = this.documents[docId];
        if (doc === undefined) {
          continue;
        }
        const docLength = doc.length;
        const denominator =
          frequency +
          k1 * (1 - b + b * (this.averageLength === 0 ? 0 : docLength / this.averageLength));
        scores[docId] = (scores[docId] ?? 0) + (idf * (frequency * (k1 + 1))) / denominator;
      }
    }
    const hits: Bm25Hit[] = [];
    for (let docId = 0; docId < count; docId += 1) {
      const score = scores[docId] ?? 0;
      if (score > 0) {
        hits.push({ id: docId, score });
      }
    }
    hits.sort((left, right) => right.score - left.score);
    return hits.slice(0, limit);
  }
}

/**
 * @beta
 * 文本分词：ASCII 词（长度 ≥2，小写）+ CJK 单字 / 二元组。
 * 兼顾中英文工具名与描述（如「读取文件」/「read_file」），无需分词器依赖。
 */
export function tokenize(text: string): string[] {
  const lower = text.toLowerCase();
  const tokens: string[] = [];
  const ascii = /[a-z0-9_]+/g;
  let match = ascii.exec(lower);
  while (match !== null) {
    const word = match[0];
    if (word.length >= 2) {
      tokens.push(word);
      // 蛇形词按 _ 拆出子词（read_file → read / file），提升子串召回。
      for (const part of word.split('_')) {
        if (part.length >= 2) {
          tokens.push(part);
        }
      }
    }
    match = ascii.exec(lower);
  }
  const cjk = /[一-鿿]+/g;
  match = cjk.exec(lower);
  while (match !== null) {
    const run = match[0];
    for (let i = 0; i < run.length; i += 1) {
      const ch = run[i];
      if (ch !== undefined) {
        tokens.push(ch);
      }
      if (i + 1 < run.length) {
        const bigram = run.slice(i, i + 2);
        tokens.push(bigram);
      }
    }
    match = cjk.exec(lower);
  }
  return tokens.filter((token) => token !== '');
}

/**
 * @beta
 * camelCase / PascalCase 拆分（保留缩略词）：
 * - `registerTool` → `register`, `tool`
 * - `ContextAssembler` → `context`, `assembler`
 * - `HTTPServer` → `http`, `server`
 * 代码标识符多为驼峰，不拆分则 `registerTool` 退化为整词 `registertool`，
 * 与查询中的 `registration` / `register` 永远无法字面命中。
 */
export function splitCamel(word: string): string[] {
  const parts: string[] = [];
  let buf = '';
  const isUpper = (c: string): boolean => c >= 'A' && c <= 'Z';
  const isLower = (c: string): boolean => c >= 'a' && c <= 'z';
  for (let i = 0; i < word.length; i += 1) {
    const c = word[i];
    if (c === undefined) continue;
    if (isUpper(c) && buf !== '') {
      const prev = buf[buf.length - 1] ?? '';
      const next = word[i + 1] ?? '';
      // 边界：小写→大写（register|Tool），或 缩略词→首字母大写（HTTP|Server）
      if (isLower(prev) || (isUpper(prev) && isLower(next))) {
        parts.push(buf);
        buf = c;
        continue;
      }
    }
    buf += c;
  }
  if (buf !== '') parts.push(buf);
  return parts.map((p) => p.toLowerCase()).filter((p) => p.length >= 2);
}

/**
 * 词形归并规则（后缀 → 替换）。代码与自然语言查询常见屈折/派生差异：
 * `spilled`/`spill`、`escalation`/`escalate`、`policies`/`policy`、`tokenizer`/`tokenize`。
 */
const MORPH_RULES: ReadonlyArray<readonly [string, string]> = [
  ['sses', 'ss'],
  ['ies', 'y'],
  ['ization', 'ize'],
  ['ations', 'ation'],
  ['ation', ''],
  ['ator', 'ate'],
  ['izer', ''],
  ['ize', ''],
  ['ement', ''],
  ['ment', ''],
  ['ness', ''],
  ['ing', ''],
  ['ion', ''],
  ['ate', 'at'],
  ['ed', ''],
  ['ers', ''],
  ['er', ''],
  ['es', ''],
  ['s', ''],
  ['ly', ''],
];

/**
 * @beta
 * 词形变体集：原词 + 所有适用规则的一步归并结果。
 * 采用「多规则并行生成」而非「首条命中即停」，因为单一后缀剥离无法统一
 * `register`/`registration`（需不同规则才收敛到同一 `registr`）。
 * 文档侧与查询侧使用同一函数，两侧同时展开后交集命中。
 */
export function morphVariants(token: string): string[] {
  const out = new Set<string>([token]);
  if (token.length < 4) return [...out];
  for (const [suffix, repl] of MORPH_RULES) {
    if (token.length > suffix.length + 2 && token.endsWith(suffix)) {
      const stem = token.slice(0, token.length - suffix.length) + repl;
      if (stem.length >= 3) out.add(stem);
    }
  }
  return [...out];
}

/**
 * @beta
 * 增强分词：在 `tokenize` 之上叠加 (1) camelCase 拆分 (2) 词形变体归并。
 * 专供代码语料检索（repo-map / 符号索引）使用；`tokenize` 保持原语义不变，
 * 以免波及工具检索、会话检索等既有调用方。
 */
export function tokenizeExpanded(text: string): string[] {
  const out = new Set<string>();
  const push = (w: string): void => {
    if (w.length < 2) return;
    const lw = w.toLowerCase();
    out.add(lw);
    for (const v of morphVariants(lw)) out.add(v);
  };

  const ascii = /[A-Za-z0-9_]+/g;
  let m = ascii.exec(text);
  while (m !== null) {
    const word = m[0];
    push(word);
    for (const part of word.split('_')) push(part);
    for (const part of splitCamel(word)) push(part);
    m = ascii.exec(text);
  }

  // CJK 沿用单字 + 二元组（无形态变化，不参与归并）。
  const cjk = /[一-鿿]+/g;
  m = cjk.exec(text);
  while (m !== null) {
    const run = m[0];
    for (let i = 0; i < run.length; i += 1) {
      const ch = run[i];
      if (ch !== undefined) out.add(ch);
      if (i + 1 < run.length) out.add(run.slice(i, i + 2));
    }
    m = cjk.exec(text);
  }
  return [...out].filter((t) => t !== '');
}
