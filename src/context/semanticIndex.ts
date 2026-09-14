/**
 * 语义召回引擎（SemanticRecallEngine）：用稠密向量补 BM25 的词法盲区。
 *
 * 设计要点：
 *  - 只依赖 EmbeddingPort（src/ports/embedding.ts），不 import 任何 embedding 实现库。
 *  - 因此可用 FakeEmbedding 单测，无需 80MB 模型；真实适配器（TransformersEmbeddingAdapter）
 *    仅在运行时经动态 import 加载 @huggingface/transformers。
 *  - 与 BM25 走「混合检索」：语义召回负责 U3 残留的 policy vs execPolicy 语义鸿沟
 *    （如查询 authorization 命中代码 permissionGate）。
 *  - 全程 fail-closed：嵌入失败 → 调用方据此回退 BM25-only，绝不崩主流程。
 */

import type { Embedding, EmbeddingPort } from '../ports/model/embedding.js';
import { at } from '../util/arrayAt.js';

/** 可嵌入的文档单元（符号或文件）。 */
export interface RecallItem {
  /** 唯一 id（如 `sym:foo` 或 `file:src/a.ts`）。 */
  readonly id: string;
  /** 用于嵌入与展示的文本。 */
  readonly text: string;
}

/** 召回结果。 */
export interface RecallHit {
  readonly id: string;
  /** 余弦相似度（已 L2 归一化时 ∈ [-1,1]，通常 ≥0）。 */
  readonly score: number;
}

/** 余弦相似度（输入视为已 L2 归一化时等价点积）。 */
export function cosine(a: Embedding, b: Embedding): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  for (let i = 0; i < n; i++) {
    dot += at(a, i) * at(b, i);
  }
  return dot;
}

/**
 * 按嵌入维度推算单批大小（纯函数，可单测）。
 *
 * 背景（真实事故，勿回退成常量）：批大小 256 是按 minilm（384 维 / 6 层）调出来的。
 * 换到 e5-large（1024 维 / 24 层）时，transformer 中间激活 ≈ batch × seq × dim × layers，
 * 随维度近似**平方**增长，实测常驻内存冲到约 11.8GB → 整机换页 → 索引构建挂死（不是慢，是假死）。
 * 故批大小必须随模型规模收缩，不能用一个常量走天下。
 */
export function defaultEmbedBatchSize(dim: number): number {
  const refDim = 384; // minilm 标定基准：该规模下 256 实测安全
  const scaled = Math.round(256 * (refDim / Math.max(dim, 1)) ** 2);
  return Math.min(256, Math.max(8, scaled));
}

/** 解析批大小：env OMNI_EMBED_BATCH（应急/调参）> 按维度推算。非法值回落推算值，不产出 NaN。 */
export function resolveEmbedBatchSize(dim: number): number {
  const raw = process.env.OMNI_EMBED_BATCH;
  if (raw !== undefined && raw.trim() !== '') {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 1) {
      return Math.floor(n);
    }
  }
  return defaultEmbedBatchSize(dim);
}

/**
 * 语义索引：索引一组文档的向量，并提供查询时的最近邻召回。
 * 索引期调用 port.embed 一次（可内部批处理）；查询期只 embed 查询文本一次。
 */
export class SemanticIndex {
  private readonly port: EmbeddingPort;
  private readonly ids: string[] = [];
  private readonly vectors: Embedding[] = [];

  /** 单次嵌入的最大批大小（按模型维度推算，见 defaultEmbedBatchSize）。 */
  private readonly batchSize: number;

  public constructor(port: EmbeddingPort) {
    this.port = port;
    this.batchSize = resolveEmbedBatchSize(port.dim);
  }

  /** 构建索引（嵌入全部文档文本）。分块嵌入以控制单批规模，结果等价但更稳健。任何嵌入异常向上抛，由调用方 fail-closed。
   * @returns 无返回值。
   */
  public async build(items: readonly RecallItem[]): Promise<void> {
    this.ids.length = 0;
    this.vectors.length = 0;
    if (items.length === 0) {
      return;
    }
    for (let i = 0; i < items.length; i += this.batchSize) {
      const slice = items.slice(i, i + this.batchSize);
      const vecs = await this.port.embed(
        slice.map((it) => it.text),
        { role: 'document' },
      );
      for (let j = 0; j < slice.length; j++) {
        const v = vecs[j];
        if (v === undefined) {
          continue;
        }
        this.ids.push(at(slice, j).id);
        this.vectors.push(v);
      }
    }
  }

  /** 查询最近邻 top-k（按余弦降序）。 */
  public async search(query: string, k = 10): Promise<RecallHit[]> {
    if (this.ids.length === 0) {
      return [];
    }
    const [qv] = await this.port.embed([query], { role: 'query' });
    if (qv === undefined) {
      return [];
    }
    const scored: RecallHit[] = [];
    for (let i = 0; i < this.ids.length; i++) {
      scored.push({ id: at(this.ids, i), score: cosine(qv, at(this.vectors, i)) });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, k);
  }
}

/**
 * 混合检索融合：Reciprocal Rank Fusion（RRF）。
 * 把多路召回（BM25 词法 + 语义向量）按排名倒数融合，对分数尺度不敏感，无需各自归一化。
 * 默认 k=60（经典取值）。
 * @param weights 可选，与 lists 等长；每路召回的贡献权重（BM25 通常取 1，语义路可 <1 以抑制噪声稀释）。
 *                 缺省则各路等权（=1）。返回按融合分降序的 id 列表。
 */
export function rrfMerge(
  lists: ReadonlyArray<readonly { readonly id: string }[]>,
  k = 60,
  weights?: ReadonlyArray<number>,
): string[] {
  const score = new Map<string, number>();
  for (let li = 0; li < lists.length; li++) {
    const w = weights?.[li] ?? 1;
    const list = at(lists, li);
    list.forEach((hit, rank) => {
      const id = hit.id;
      score.set(id, (score.get(id) ?? 0) + w / (k + rank + 1));
    });
  }
  return [...score.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
}
