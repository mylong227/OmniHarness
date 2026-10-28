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
  /**
   * 写入提示缓存的 prompt token 数（可选）。
   *
   * Anthropic `usage.cache_creation_input_tokens`：这部分**已包含在 `promptTokens` 里**
   * （见 `AnthropicModel.usageOf` 的口径），但计价必须与普通输入/缓存命中分开——
   * 写入按 1.25× 输入价，混在 `promptTokens` 里会按 1× 少记。
   * 其它厂商的自动缓存没有单独的写入费，缺省 undefined。
   */
  readonly cacheCreationPromptTokens?: number | undefined;
  /**
   * 该用量是**本地估算**（端点未回传 usage，2026-10-21）。
   *
   * 成本预算在缺 usage 时按本地 token 估算记账并置位本字段；读方（UI/统计）应把这类
   * 数字标注为估算，不能与厂商回传的精确值混为一谈。
   */
  readonly estimated?: boolean | undefined;
}
