/**
 * 嵌入端口（EmbeddingPort）：语义向量化能力的抽象边界。
 *
 * 设计要点（铁律 §2.5 分层隔离）：
 *  - 本文件位于 src/ports/**，第三方-free，只定义接口，绝不 import 任何 embedding 实现库。
 *  - 具体实现（@huggingface/transformers 等）只落在 src/adapters/embedding/**，
 *    对外仅暴露本端口类型，换实现 = 改 1 个适配器文件。
 *  - SemanticRecallEngine（src/context）只依赖本端口，因此可用 FakeEmbedding 单测，无需 80MB 模型。
 */

/** 单条文本的嵌入向量（归一化后的余弦空间）。 */
export type Embedding = readonly number[];

/** 嵌入请求选项。 */
export interface EmbedOptions {
  /** 归一化（L2）：语义相似度用余弦时建议 true（默认 true）。 */
  readonly normalize?: boolean;
  /** 批处理大小（实现可分批前向以省内存）。 */
  readonly batchSize?: number;
  /**
   * 文本角色：'query' 表示这是检索查询，'document' 表示这是被检索的文档。
   * 仅对需要查询/文档不对称前缀的模型有意义（如 e5 家族要求
   * "query: " / "passage: " 前缀）。默认 'document'（适配器按模型决定是否应用前缀）。
   */
  readonly role?: 'query' | 'document';
}

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
}
