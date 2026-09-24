/**
 * 文本 → token 数的**有界 LRU 缓存**（审计 §2.4 后半：「每步全文记账无前缀缓存」）。
 *
 * ## 为什么需要
 *
 * 上下文记账每步都会遍历**全部**消息并对每条 `content` 重新数 token（`TokenEstimator`）。
 * 上下文随步数增长 ⇒ 全会话 O(n²)：审计实测 170 KB / 850 KB / 2.55 MB 上下文分别为
 * **10 / 48 / 84 ms/步**。而相邻两步之间**绝大多数消息逐字未变**——变化的只有新增的那几条。
 *
 * ## 为什么「按内容字符串」做键是安全的
 *
 * token 计数是**纯函数**（同一文本必然同一计数），没有 TTL / 失效问题；
 * 键就是内容本身，命中即等价于重算。于是每步只需为**新增或改动的消息**付代价。
 * （这正是「前缀增量」的实现方式：稳定前缀各条各自命中，只有尾部新增项未命中。）
 *
 * ## 为什么必须有界
 *
 * 长会话里消息内容各不相同，无界 Map 会随会话单调增长（与 §1.7 的 spill/涡环包同型问题）。
 * 故按 LRU 保留最近 `maxEntries` 条——上下文记账的访问模式是「从头到尾扫一遍」，
 * 刚刚用过的条目最可能在下一次再用，LRU 命中率接近上限。
 */

/** 缓存观测计数。 */
export interface TokenCountCacheStats {
  /** 命中次数。 */
  readonly hits: number;
  /** 未命中次数。 */
  readonly misses: number;
  /** 当前条目数。 */
  readonly size: number;
}

/** 文本 → token 数的有界 LRU 缓存。 */
export class TokenCountCache {
  /** 条目表：Map 的插入顺序即 LRU 顺序（队首最旧）。 */
  private readonly entries = new Map<string, number>();

  /** 命中计数（观测/测试用）。 */
  private hits = 0;

  /** 未命中计数（观测/测试用）。 */
  private misses = 0;

  /**
   * @param maxEntries 最多保留的条目数（≤0 表示禁用缓存，行为等价于每次重算）。
   */
  public constructor(private readonly maxEntries = 512) {}

  /**
   * 取缓存计数；命中时把该条目移到队尾（最近使用）。
   * @param text 待查文本。
   * @returns 缓存的 token 数；未命中为 `undefined`。
   */
  public get(text: string): number | undefined {
    if (this.maxEntries <= 0) {
      this.misses += 1; // 禁用也要如实计数，否则观测面看起来「零访问」而非「未启用缓存」
      return undefined;
    }
    const cached = this.entries.get(text);
    if (cached === undefined) {
      this.misses += 1;
      return undefined;
    }
    // 续命：删了再插即移到队尾（Map 保序）。
    this.entries.delete(text);
    this.entries.set(text, cached);
    this.hits += 1;
    return cached;
  }

  /**
   * 写入缓存；超出上限时逐出队首（最久未使用）。
   * @param text 文本（键）。
   * @param tokens token 数。
   * @returns 无返回值。
   */
  public set(text: string, tokens: number): void {
    if (this.maxEntries <= 0) {
      return;
    }
    if (this.entries.has(text)) {
      this.entries.delete(text);
    }
    this.entries.set(text, tokens);
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done === true) {
        return;
      }
      this.entries.delete(oldest.value);
    }
  }

  /**
   * 某文本是否在缓存里（测试用；**不改动** LRU 顺序）。
   * @param text 待查文本。
   * @returns 在缓存中返回 true。
   */
  public has(text: string): boolean {
    return this.entries.has(text);
  }

  /**
   * 当前条目数。
   * @returns 条目数。
   */
  public size(): number {
    return this.entries.size;
  }

  /**
   * 观测计数。
   * @returns `{ hits, misses, size }`。
   */
  public stats(): TokenCountCacheStats {
    return { hits: this.hits, misses: this.misses, size: this.entries.size };
  }

  /**
   * 清空缓存与计数。
   * @returns 无返回值。
   */
  public clear(): void {
    this.entries.clear();
    this.hits = 0;
    this.misses = 0;
  }
}
