/**
 * repo-map 结果的**单槽位 memo**（审计 §2.4 前半：`repo-map 结果零记忆化`）。
 *
 * ## 为什么需要
 *
 * `core/stepContextBuilder.ts` 每步都调 repo-map，而它推导出的查询文本在同一回合内
 * **逐字相同**（`deriveQueryText` 取最近至多 3 条 user 消息）。BM25 侧已有索引缓存
 * （`CorpusIndexCache`），但「检索 + 精排 + 梯度投送格式化」这一整段每步都在重做。
 *
 * ## 为什么不会读到陈旧结果（关键设计）
 *
 * 语料是**会变的**（agent 自己改文件），所以「按查询文本缓存」有读陈旧的风险。本类的做法是
 * **同时比对语料实例**：`CorpusIndexCache` 每次（重新）建索引都会产出**新的对象实例**，
 * 因此只要 `corpus` 引用变了（TTL 到期重扫、被驱逐后重建、`clear()`），memo 立刻 miss。
 * 这比「按 TTL 猜」精确：**缓存生命期严格不长于语料实例的生命期**。
 *
 * 单槽位（而非多槽位）是刻意的：同一回合内查询逐字相同、且 step 之间交替极少，
 * 单槽位命中率已接近上限，而它**不需要任何淘汰策略**、内存恒定（一份文本）。
 */

/** repo-map memo 的一次命中/未命中判定结果。 */
export interface RepoMapMemoHit {
  /** 是否命中（true 时 `text` 可直接返回）。 */
  readonly hit: boolean;
  /** 命中时的缓存文本（可能是 `null`——「无结果」也是合法结果，必须一并缓存）。 */
  readonly text: string | null;
}

/**
 * repo-map 结果单槽位 memo（键 = 调用指纹，另按语料实例判失效）。
 */
export class RepoMapMemo {
  /** 当前槽位：键 + 语料实例 + 结果文本。 */
  private slot: {
    readonly key: string;
    readonly corpus: object;
    readonly text: string | null;
  } | null = null;

  /** 命中次数（观测/测试用）。 */
  private hits = 0;

  /** 未命中次数（观测/测试用）。 */
  private misses = 0;

  /**
   * 查表：键与语料实例都必须一致才算命中。
   * @param key 调用指纹（root + 查询 + 生效旋钮）。
   * @param corpus 本次使用的语料实例（引用比较，用于发现重新索引）。
   * @returns 命中判定与（命中时的）缓存文本。
   */
  public lookup(key: string, corpus: object): RepoMapMemoHit {
    if (this.slot !== null && this.slot.key === key && this.slot.corpus === corpus) {
      this.hits += 1;
      return { hit: true, text: this.slot.text };
    }
    this.misses += 1;
    return { hit: false, text: null };
  }

  /**
   * 写入槽位（覆盖旧槽位；`text` 允许为 `null`）。
   * @param key 调用指纹。
   * @param corpus 语料实例。
   * @param text 结果文本（`null` = 无结果）。
   * @returns 无返回值。
   */
  public store(key: string, corpus: object, text: string | null): void {
    this.slot = { key, corpus, text };
  }

  /**
   * 清空槽位（`RepoMapContextEngine.clear()` 调用，保持与语料/语义缓存同生命周期）。
   * @returns 无返回值。
   */
  public invalidate(): void {
    this.slot = null;
  }

  /**
   * 观测计数（测试与诊断用）。
   * @returns `{ hits, misses, filled }`：命中数、未命中数、槽位是否已填。
   */
  public stats(): { readonly hits: number; readonly misses: number; readonly filled: boolean } {
    return { hits: this.hits, misses: this.misses, filled: this.slot !== null };
  }
}
