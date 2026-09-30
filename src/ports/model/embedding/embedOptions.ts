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
