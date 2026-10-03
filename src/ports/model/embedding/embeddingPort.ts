import type { Embedding } from './embedding.js';
import type { EmbedOptions } from './embedOptions.js';
import type { EmbeddingPreloadOutcome } from './embeddingPreloadOutcome.js';

/**
 * 嵌入端口：把文本映射为稠密向量，用于语义召回（补 BM25 的词法盲区）。
 * 实现可以是本地 ONNX 模型、远程 API、或测试用确定性伪嵌入。
 */
export interface EmbeddingPort {
  /** 维度（实现在构造/首次加载时确定，如 all-MiniLM-L6-v2 = 384）。 */
  readonly dim: number;
  /**
   * 批量嵌入文本。返回与输入等长的向量数组。
   * 任何异常（模型缺失 / 离线）应由实现方向上抛出，由调用方 fail-closed 处理。
   */
  embed(texts: readonly string[], opts?: EmbedOptions): Promise<readonly Embedding[]>;
  /**
   * **可选**：预热并回报冷启动成本。
   *
   * 存在意义（L5）：首向量化要承担「加载实现库 + 取权重 + 建管线」的整段耗时，若发生在
   * 首个用户查询上就是**静默的长尾延迟**。实现方提供本方法后，装配层可在启动期显式触发，
   * 把成本前置到可自主选择的时刻，并得到一个可读数字。
   *
   * 契约：**不得抛错**（失败应以 `{ok:false, error}` 回报）；未实现的端口允许缺省。
   */
  preload?(): Promise<EmbeddingPreloadOutcome>;
  /**
   * **可选**：把内部缓冲的向量**持久化**（带落盘缓存的实现提供）。
   *
   * 存在理由（2026-10-03 实测缺陷）：`DiskCachedEmbeddingAdapter` 的类文档写明
   * 「`flush()` 公开给装配层在关停时显式调用」，但仓内**没有任何调用点**——于是每次
   * 索引构建都有最多 `flushThreshold − 1` 条向量**静默不落盘**，进程重启后重付这段编码。
   * 实测（真实模型，1108 条语料、阈值 512）：**84 条**丢失。
   *
   * 调用契约：`SemanticIndexCache` 在**构建成功后**调用一次（那是向量刚产生的时刻，
   * 比「关停时」更早且必然发生）；未实现的端口允许缺省，故调用点一律用 `?.`。
   * @returns 落盘结果（`boolean` 由实现自定语义：false 表示无待落盘或落盘失败，
   *   实现方须自行留痕）；返回 void 亦合法。
   */
  flush?(): boolean | void;
}
