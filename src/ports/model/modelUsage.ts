/** 模型用量统计（token 级，#S29）。 */
export interface ModelUsage {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
  /**
   * 命中「提示缓存」的 prompt token 数（可选）。
   *
   * 三个厂商各有回传字段：OpenAI 兼容 `usage.prompt_tokens_details.cached_tokens`、
   * DeepSeek `usage.prompt_cache_hit_tokens`、Anthropic `usage.cache_read_input_tokens`。
   * 端点未回传时为 undefined——**绝不臆造**：缺值只能表示「未知」，不能记作 0 命中，
   * 否则会把「无数据」误算成「缓存全未命中」，拉低统计出的平均命中率。
   */
  readonly cachedPromptTokens?: number | undefined;
}
