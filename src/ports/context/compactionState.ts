/** 压缩状态（V2 游标）：已被摘要覆盖的前缀长度 + 前缀指纹。持久化后可跨步复用摘要。 */
export interface CompactionState {
  /** 原始投影消息序列中被摘要覆盖的消息数（前缀长度）。 */
  readonly compactedUpTo: number;
  /** 前缀指纹（djb2），用于校验投影前缀未漂移。 */
  readonly headHash: string;
  /** 摘要文本。 */
  readonly summary: string;
}
