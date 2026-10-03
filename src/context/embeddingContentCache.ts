import { createHash } from 'node:crypto';
import type { Embedding } from '../ports/model/embedding.js';

/** 缓存统计。 */
export interface EmbeddingCacheStats {
  /** 命中次数（复用既有向量，未调用内层端口）。 */
  readonly hits: number;
  /** 未命中次数（必须调用内层端口）。 */
  readonly misses: number;
  /** 当前条目数。 */
  readonly entries: number;
}

/**
 * **嵌入内容缓存**：按「文本内容 + 角色」复用向量，跨语料版本有效。
 *
 * ## 它解决什么（2026-10-03，`docs/PROJECT_BOARD.md` §3.2）
 *
 * `SemanticIndexCache` 的缓存键含**语料实例身份**（审计 R3 的必要设计：否则旧索引会被拿去
 * 新语料里解析 `sym:<i>`，轻则静默丢弃、重则张冠李戴）。代价是：语料只要变一个文件，
 * 就是一个新语料对象 ⇒ 新键 ⇒ **整仓重新嵌入**。而嵌入是全链路最贵的一步
 * （本仓 3227 文件 / 6.7 万符号，用本地 ONNX 模型也是分钟级），一次编辑只改一两个文件，
 * 却要重算全部向量。
 *
 * 本缓存把「语料身份」与「内容身份」解耦：索引对象仍按语料身份重建（保持 R3 的正确性），
 * 但**每个待嵌入文本的向量**按内容复用 ⇒ 重建时只有真的变了的条目会真正调用模型。
 *
 * ## 键与作用域（诚实边界）
 *
 *  - 键 = `角色 \0 sha1(文本)`。**角色必须进键**：e5 家族对 query / passage 加不同前缀，
 *    同一文本在两个角色下的向量不同，混用会静默劣化召回。
 *  - 用哈希而不是原始文本作键：文件文档最大 8000 字符，直接作键会额外常驻一份派生文本；
 *    哈希键定长，代价是每次构建多一遍 SHA-1（本仓 6.7 万条量级实测 ~0.1s，相对嵌入可忽略）。
 *  - **假设同一模型**：端口契约里没有模型标识，故本缓存按「同一实例生命周期内模型不变」
 *    使用（生产装配里端口注入一次、随进程稳定）。`CachedEmbeddingPort` 另加一道维度校验：
 *    取回的向量长度与当前端口 `dim` 不符即视为未命中，兜住「换了不同维度模型」这一最常见的
 *    切换形态；同维不同模型的极端情形**未覆盖**，在此如实登记。
 *
 * ## 内存有界（按代际清扫，而不是简单 LRU）
 *
 * 每次成功构建前 `beginGeneration()`、成功后 `endGeneration()`：后者丢弃**本次构建没碰过**的条目。
 * 于是常驻向量 ≈ 一份当前索引的量级（与 `SemanticIndex` 自身持有的一样多），
 * 既不会随编辑次数单调增长，也不会因为 LRU 太小而在下一次编辑时几乎全部未命中而退化。
 */
export class EmbeddingContentCache {
  /** 条目：向量 + 最近一次被使用的代际号。 */
  private readonly entries = new Map<string, { vector: Embedding; generation: number }>();
  /** 当前代际（每次 `beginGeneration` 递增）。 */
  private generation = 1;
  /** 命中次数（观测用，单调递增，不随清扫回退）。 */
  private hits = 0;
  /** 未命中次数（= 真实调用模型的文本条数；观测用，单调递增）。 */
  private misses = 0;

  /**
   * 查表。
   * @param text 待嵌入文本。
   * @param role 文本角色（`undefined` = 未指定，与 `'document'` 区分开）。
   * @param dim 当前端口的向量维度（长度不符即视为未命中）。
   * @returns 命中的向量；未命中返回 undefined。
   */
  public lookup(text: string, role: string | undefined, dim: number): Embedding | undefined {
    const key = EmbeddingContentCache.keyOf(text, role);
    const entry = this.entries.get(key);
    if (entry === undefined || entry.vector.length !== dim) {
      this.misses += 1;
      return undefined;
    }
    entry.generation = this.generation;
    this.hits += 1;
    return entry.vector;
  }

  /**
   * 写入（未命中后由调用方填）。同一键重复写入以最新为准。
   * @param text 待嵌入文本。
   * @param role 文本角色。
   * @param vector 模型返回的向量。
   * @returns 无返回值。
   */
  public store(text: string, role: string | undefined, vector: Embedding): void {
    this.entries.set(EmbeddingContentCache.keyOf(text, role), {
      vector,
      generation: this.generation,
    });
  }

  /** 开始新一代（构建前调用）：此后被查到/写入的条目才算「本次构建用过」。
   * @returns 无返回值。
   */
  public beginGeneration(): void {
    this.generation += 1;
  }

  /** 结束一代（**构建成功后**调用）：丢弃本次构建没碰过的条目。
   *
   * 为什么只在成功后清扫：构建失败（模型离线/维度不符抛错）时只写入了部分条目，
   * 此时清扫会把上一代的可用向量一并丢掉，下次重试要从零开始嵌入。
   * @returns 无返回值。
   */
  public endGeneration(): void {
    for (const [key, entry] of [...this.entries]) {
      if (entry.generation !== this.generation) {
        this.entries.delete(key);
      }
    }
    this.generation += 1;
  }

  /** 清空（`SemanticIndexCache.clear(root)` 时一并调用，保持两类缓存一致）。
   * @returns 无返回值。
   */
  public clear(): void {
    this.entries.clear();
  }

  /**
   * 统计。
   * @returns `{ hits, misses, entries }`。
   */
  public stats(): EmbeddingCacheStats {
    return { hits: this.hits, misses: this.misses, entries: this.entries.size };
  }

  /**
   * 缓存键：`角色 \0 sha1(文本)`。
   * @param text 待嵌入文本。
   * @param role 文本角色（undefined 记为 `-`，与 `'document'` 区分）。
   * @returns 定长键。
   */
  private static keyOf(text: string, role: string | undefined): string {
    return `${role ?? '-'}\u0000${createHash('sha1').update(text, 'utf8').digest('hex')}`;
  }
}
