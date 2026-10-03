/**
 * 无第三方依赖 Okapi BM25 检索器（#M1 工具语义检索）。
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

import { ArrayAt } from '../util/arrayAt.js';

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
      this.addDocument(tokens);
    }
  }

  /**
   * 追加单篇已分词文档。
   * @param tokens 该文档的词项列表（**保留词频**，调用方负责按文档侧口径传入）。
   * @returns 该文档的槽位（= 追加前的 `documentCount`）。
   */
  public addDocument(tokens: readonly string[]): number {
    const slot = this.documents.length;
    this.documents.push([...tokens]);
    this.totalTokens += tokens.length;
    this.indexTerms(slot, tokens);
    this.refreshAverageLength();
    return slot;
  }

  /**
   * 就地在**指定槽位**写入或替换一篇文档（增量维护语料时用）。
   *
   * 存在理由（2026-10-03，repo-map 写后重索引）：`addDocuments` 全量重建在本仓语料实测
   * **约 3.0s**（3223 文件 / 33.5 MB 语料：file 索引 2.2s + symbol 索引 0.8s），而写类工具
   * 之后的改动通常只涉及**一两个文件**。就地替换把代价降到「该文件自身的词项数」：
   * 旧词项的 df/postings 先摘除，新词项按 docId 升序插回（保持 `search` 的浮点累加顺序不变）。
   *
   * 契约：`slot` 必须是已存在槽位或正好等于 `documentCount`（后者等价于追加）。
   * **槽位不会因替换而增减**，故调用方可以持有稳定的「文件 → 槽位」映射。
   * @param slot 目标槽位。
   * @param tokens 该文档的新词项列表（保留词频）。
   * @returns 无返回值。
   * @throws Error `slot` 越界（负数或 > documentCount）时抛出——fail-closed，防静默错位。
   */
  public setDocument(slot: number, tokens: readonly string[]): void {
    if (!Number.isInteger(slot) || slot < 0 || slot > this.documents.length) {
      throw new Error(
        `BM25 槽位越界：${String(slot)}（合法范围 0..${String(this.documents.length)}）`,
      );
    }
    if (slot === this.documents.length) {
      this.addDocument(tokens);
      return;
    }
    const previous = this.documents[slot] ?? [];
    this.totalTokens += tokens.length - previous.length;
    this.unindexTerms(slot, previous);
    this.documents[slot] = [...tokens];
    this.indexTerms(slot, tokens);
    this.refreshAverageLength();
  }

  /**
   * 已用槽位总数（= `documentCount`；替换不改变槽位数，故两者恒等）。
   * @returns 槽位数。
   */
  public get slotCount(): number {
    return this.documents.length;
  }

  /** 把一篇文档的词项计入 df 与倒排表（docId 升序插入，保持累加顺序稳定）。
   * @param docId 文档槽位。
   * @param tokens 该文档词项（保留词频）。
   * @returns 无返回值。
   */
  private indexTerms(docId: number, tokens: readonly string[]): void {
    const termFrequency = new Map<string, number>();
    for (const term of tokens) {
      termFrequency.set(term, (termFrequency.get(term) ?? 0) + 1);
    }
    for (const [term, frequency] of termFrequency) {
      this.documentFrequency.set(term, (this.documentFrequency.get(term) ?? 0) + 1);
      const posting = this.postings.get(term);
      if (posting === undefined) {
        this.postings.set(term, { ids: [docId], tfs: [frequency] });
        continue;
      }
      const at = Bm25Index.lowerBound(posting.ids, docId);
      posting.ids.splice(at, 0, docId);
      posting.tfs.splice(at, 0, frequency);
    }
  }

  /** 把一篇文档的词项从 df 与倒排表摘除（`setDocument` 的替换前半程）。
   * @param docId 文档槽位。
   * @param tokens 该槽位**替换前**的词项。
   * @returns 无返回值。
   */
  private unindexTerms(docId: number, tokens: readonly string[]): void {
    const termFrequency = new Map<string, number>();
    for (const term of tokens) {
      termFrequency.set(term, (termFrequency.get(term) ?? 0) + 1);
    }
    for (const term of termFrequency.keys()) {
      const df = this.documentFrequency.get(term);
      if (df !== undefined) {
        if (df <= 1) {
          this.documentFrequency.delete(term);
        } else {
          this.documentFrequency.set(term, df - 1);
        }
      }
      const posting = this.postings.get(term);
      if (posting === undefined) {
        continue;
      }
      const at = Bm25Index.lowerBound(posting.ids, docId);
      if (posting.ids[at] === docId) {
        posting.ids.splice(at, 1);
        posting.tfs.splice(at, 1);
      }
      if (posting.ids.length === 0) {
        this.postings.delete(term);
      }
    }
  }

  /** 二分求首个 ≥ `docId` 的位置（`ids` 恒升序）。
   * @param ids 升序 docId 数组。
   * @param docId 目标 docId。
   * @returns 插入/定位下标。
   */
  private static lowerBound(ids: readonly number[], docId: number): number {
    let lo = 0;
    let hi = ids.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if ((ids[mid] ?? Number.POSITIVE_INFINITY) < docId) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }
    return lo;
  }

  /** 重算平均文档长度（`Σ|doc| / N`，跨批与增量替换口径一致）。
   * @returns 无返回值。
   */
  private refreshAverageLength(): void {
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
        const docId = ArrayAt.at(posting.ids, p);
        const frequency = ArrayAt.at(posting.tfs, p);
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

  /**
   * @beta
   * 文本分词：ASCII 词（长度 ≥2，小写）+ CJK 单字 / 二元组。
   * 兼顾中英文工具名与描述（如「读取文件」/「read_file」），无需分词器依赖。
   */
  public static tokenize(text: string): string[] {
    const lower = text.toLowerCase();
    const tokens: string[] = [];
    // Unicode 属性转义而非写死区间（2026-09-26 审计 R9）：原先 `/[a-z0-9_]+/` + `/[一-鿿]+/`
    // 只覆盖 ASCII 与 U+4E00–9FFF —— 带音标的拉丁词被切碎（`naïve` → `na`+`ve`），
    // 假名/谚文**零 token**（日韩查询完全不可检索），CJK 扩展区与全角拉丁同样漏掉。
    const ascii = /[\p{Script=Latin}\p{N}_]+/gu;
    let match = ascii.exec(lower);
    while (match !== null) {
      const word = match[0];
      if (word.length >= 2) {
        tokens.push(word);
        // 蛇形词按 _ 拆出子词（read_file → read / file），提升子串召回。
        // 只在**真含下划线**时拆：`word.split('_')` 对无下划线的词会返回 `[word]` 自身，
        // 旧实现无条件拆 ⇒ 每个非蛇形词被 push 两次（tf 与文档长度双双虚高 ~1.26×，
        // 实测 wholeCorpusTokens 从 80.9 万膨胀到 101.7 万），BM25 的 tf/长度项被系统性扭曲。
        if (word.includes('_')) {
          for (const part of word.split('_')) {
            if (part.length >= 2) {
              tokens.push(part);
            }
          }
        }
      }
      match = ascii.exec(lower);
    }
    // CJK（含扩展区）+ 日文假名 + 谚文：逐字 + 二元组（与原先对汉字的口径一致）。
    // 码点迭代而非 UTF-16 码元下标（2026-10-03 修）：`run[i]` 对星形扩展区字符（CJK Ext B 等）
    // 产出孤立代理项、`slice(i, i+2)` 错位成对——`Array.from` 取完整码点后再组二元组。
    const cjk = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu;
    match = cjk.exec(lower);
    while (match !== null) {
      const cps = Array.from(match[0]);
      for (let i = 0; i < cps.length; i += 1) {
        const ch = cps[i];
        const next = cps[i + 1];
        if (ch !== undefined) {
          tokens.push(ch);
        }
        if (ch !== undefined && next !== undefined) {
          tokens.push(ch + next);
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
  public static splitCamel(word: string): string[] {
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
   * @beta
   * 词形变体集：原词 + 所有适用规则的一步归并结果。
   * 采用「多规则并行生成」而非「首条命中即停」，因为单一后缀剥离无法统一
   * `register`/`registration`（需不同规则才收敛到同一 `registr`）。
   * 文档侧与查询侧使用同一函数，两侧同时展开后交集命中。
   */
  public static morphVariants(token: string): string[] {
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
  public static tokenizeExpanded(text: string): string[] {
    return Bm25Index.expandedTokens(text, true);
  }

  /**
   * @beta
   * 与 {@link tokenizeExpanded} 同口径，但**保留词频**（不做集合去重）。
   *
   * 为什么要它（2026-09-26 审计 R6）：`tokenizeExpanded` 内部用 `Set` 去重，于是**索引侧**的
   * tf 恒为 1 —— BM25 的 tf 分量与调优过的 `k1` 对符号索引（以及文件路径部分）完全失效
   * （实测 `tokenizeExpanded('alpha alpha alpha alpha')` 与 `'alpha'` 打分完全相同）。
   * 查询侧仍需去重（重复查询词不该重复计分），故两个变体并存：**文档用本方法，查询用上面那个**。
   * @param text 待分词的文档文本。
   * @returns 词项列表（含重复，顺序即出现顺序）。
   */
  public static tokenizeExpandedCounted(text: string): string[] {
    return Bm25Index.expandedTokens(text, false);
  }

  /**
   * 扩展分词实现（去重与保留词频共用同一套规则，避免两个变体口径漂移）。
   * @param text 待分词文本。
   * @param dedup true=集合去重（查询侧）；false=保留词频（文档侧）。
   * @returns 词项列表。
   */
  private static expandedTokens(text: string, dedup: boolean): string[] {
    const out = new Set<string>();
    const list: string[] = [];
    const push = (w: string): void => {
      if (w.length < 2) return;
      const lw = w.toLowerCase();
      if (dedup) {
        out.add(lw);
        for (const v of Bm25Index.morphVariants(lw)) out.add(v);
        return;
      }
      list.push(lw);
      for (const v of Bm25Index.morphVariants(lw)) {
        // `morphVariants` 把原词自身也算作一个变体：计数路径必须跳过它，否则每次出现都被 push
        // 两次（tf 直接翻倍）——与本类 `tokenize` 里那个「无下划线词被 push 两次」的缺陷同型。
        if (v !== lw) list.push(v);
      }
    };

    // Unicode 口径与 `tokenize` 对齐（2026-10-03 修）：`expandedTokens` 是**查询侧**
    // （candidateSearch / grepTopKFiles）与**符号文档侧**
    // （tokenizeExpandedCounted）的共用实现——此前仍用 pre-R9 的 ASCII/汉字区间，
    // 假名/谚文/带音标拉丁词在这里产零 token 或碎片 ⇒ 日韩查询在 morph 默认开的生产
    // 检索路径完全不可检索（R9 只修了 `tokenize`，漏了这条更热的路径）。
    const ascii = /[\p{Script=Latin}\p{N}_]+/gu;
    let m = ascii.exec(text);
    while (m !== null) {
      const word = m[0];
      push(word);
      // 跳过「自身即整词」的拆分结果：`word.split('_')` 对无下划线词返回 `[word]`，
      // `splitCamel` 对全小写词同样返回 `[word]` —— 去重路径下这两次是空操作（Set 幂等），
      // 但计数路径会把 tf 直接翻三倍（与 `tokenize` 里那个同型缺陷一个道理）。
      for (const part of word.split('_')) {
        if (part !== word) push(part);
      }
      for (const part of Bm25Index.splitCamel(word)) {
        if (part !== word) push(part);
      }
      m = ascii.exec(text);
    }

    // CJK 沿用单字 + 二元组（无形态变化，不参与归并）；码点迭代防孤立代理项（同 tokenize）。
    const cjk = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu;
    m = cjk.exec(text);
    while (m !== null) {
      const cps = Array.from(m[0]);
      for (let i = 0; i < cps.length; i += 1) {
        const ch = cps[i];
        const next = cps[i + 1];
        if (ch === undefined) {
          continue;
        }
        if (dedup) {
          out.add(ch);
          if (next !== undefined) out.add(ch + next);
        } else {
          list.push(ch);
          if (next !== undefined) list.push(ch + next);
        }
      }
      m = cjk.exec(text);
    }
    return dedup ? [...out].filter((t) => t !== '') : list.filter((t) => t !== '');
  }
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
