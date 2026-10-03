import type {
  Embedding,
  EmbedOptions,
  EmbeddingPort,
  EmbeddingPreloadOutcome,
} from '../ports/model/embedding.js';
import type { EmbeddingContentCache } from './embeddingContentCache.js';

/**
 * 装饰 `EmbeddingPort`：按**内容**复用向量，只把未命中的文本交给内层端口。
 *
 * 设计取舍（2026-10-03，`docs/PROJECT_BOARD.md` §3.2）：
 *  - **装饰在端口边界**，而不是改 `SemanticIndex`：索引与查询两条路径都自动受益
 *    （查询文本同样按内容复用），且 `SemanticIndex` 保持「只管向量与余弦」的单一职责。
 *  - **保持返回顺序与长度**：内层端口按调用方给的顺序返回等长数组，本类对未命中项批量调用后
 *    按原下标回填，故调用方（含分批嵌入的 `SemanticIndex`）行为逐字不变。
 *  - **选项透传**：`opts` 原样传给内层（`normalize` / `batchSize` 等由实现解释），
 *    只有 `role` 参与缓存键（见 `EmbeddingContentCache` 的键说明）。
 *  - **`preload` 仅在实现侧存在时透出**：装配层用 `embedding.preload?.()` 判断能力，
 *    无条件暴露该方法会把「不支持预热」伪装成「支持」。
 */
export class CachedEmbeddingPort implements EmbeddingPort {
  /** 维度（与内层一致；`SemanticIndex` 用它推算批大小）。 */
  public readonly dim: number;

  /**
   * @param inner 内层端口（真实模型适配器）。
   * @param cache 内容缓存（由 `SemanticIndexCache` 持有，跨语料版本复用）。
   */
  public constructor(
    private readonly inner: EmbeddingPort,
    private readonly cache: EmbeddingContentCache,
  ) {
    this.dim = inner.dim;
    if (inner.preload !== undefined) {
      const preload = inner.preload.bind(inner);
      this.preload = (): Promise<EmbeddingPreloadOutcome> => preload();
    }
    // `flush` 同理必须**透传**：落盘缓存（`DiskCachedEmbeddingAdapter`）的向量要经它落盘，
    // 装饰器若吞掉该方法，`SemanticIndexCache` 的「构建后落盘」就会静默失效。
    if (inner.flush !== undefined) {
      const flush = inner.flush.bind(inner);
      this.flush = (): boolean | void => flush();
    }
  }

  /** 可选预热（仅当内层支持时存在，契约与 `EmbeddingPort.preload` 一致）。 */
  public preload?: () => Promise<EmbeddingPreloadOutcome>;

  /** 可选落盘（仅当内层支持时存在，契约与 `EmbeddingPort.flush` 一致）。 */
  public flush?: () => boolean | void;

  /**
   * 批量嵌入（命中直接复用，未命中才调用内层）。
   * @param texts 待嵌入文本。
   * @param opts 嵌入选项（`role` 参与缓存键，其余透传）。
   * @returns 与输入等长的向量数组（顺序与输入一一对应）。
   */
  public async embed(texts: readonly string[], opts?: EmbedOptions): Promise<readonly Embedding[]> {
    const role = opts?.role;
    const out = new Array<Embedding | undefined>(texts.length);
    const missIndexes: number[] = [];
    const missTexts: string[] = [];
    for (let i = 0; i < texts.length; i += 1) {
      const text = texts[i] ?? '';
      const hit = this.cache.lookup(text, role, this.dim);
      if (hit !== undefined) {
        out[i] = hit;
        continue;
      }
      missIndexes.push(i);
      missTexts.push(text);
    }
    if (missTexts.length > 0) {
      const fresh = await this.inner.embed(missTexts, opts);
      for (let j = 0; j < missIndexes.length; j += 1) {
        const vector = fresh[j];
        const at = missIndexes[j];
        if (vector === undefined || at === undefined) {
          continue;
        }
        out[at] = vector;
        this.cache.store(missTexts[j] ?? '', role, vector);
      }
    }
    // 内层可能少返向量（实现差异）：保持与内层契约一致的「等长数组 + 缺失位为 undefined」
    // 由调用方判空（`SemanticIndex.build` 对 undefined 跳过），故此处按原样返回稀疏数组。
    return out as readonly Embedding[];
  }
}
