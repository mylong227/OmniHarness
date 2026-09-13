/**
 * 提示缓存（prompt cache）命中量读取器。
 *
 * 三家端点的字段名与嵌套层级各不相同，且都**可选**（同一厂商不同版本、代理网关
 * 转发时都可能丢字段）。本类把「从任意 raw usage 对象里安全取出命中 token 数」
 * 收成一处，供各模型适配器在构造 ModelUsage 时复用，避免三份各自为政的窄化代码漂移。
 *
 * fail-soft：字段缺失、类型不是有限数、负值三种情况一律返回 undefined（= 未知），
 * **不返回 0**——0 是「确实一次都没命中」的有效观测，与「没这个字段」语义不同，
 * 混用会让上层算出的平均缓存命中率系统性偏低。
 */

/** 提示缓存命中量读取器（无状态，可安全并发复用）。 */
export class PromptCacheUsageReader {
  /**
   * 读 OpenAI 兼容端点的缓存命中量：优先 `prompt_tokens_details.cached_tokens`，
   * 回退 DeepSeek 风格的 `prompt_cache_hit_tokens`（DeepSeek 与 OpenAI 共用同一适配器）。
   * @param raw 端点返回的 usage 对象（未知类型，内部逐层窄化）
   * @returns 命中 token 数；无法判定时为 undefined
   */
  public readOpenAiCompatible(raw: unknown): number | undefined {
    const usage = this.record(raw);
    if (usage === undefined) return undefined;
    const details = this.record(usage['prompt_tokens_details']);
    return (
      this.nonNegativeInt(details?.['cached_tokens']) ??
      this.nonNegativeInt(usage['prompt_cache_hit_tokens'])
    );
  }

  /**
   * 读 OpenAI Responses API 的缓存命中量：`input_tokens_details.cached_tokens`。
   * @param raw 端点返回的 usage 对象（未知类型，内部逐层窄化）
   * @returns 命中 token 数；无法判定时为 undefined
   */
  public readResponses(raw: unknown): number | undefined {
    const usage = this.record(raw);
    if (usage === undefined) return undefined;
    const details = this.record(usage['input_tokens_details']);
    return this.nonNegativeInt(details?.['cached_tokens']);
  }

  /**
   * 读 Anthropic 的缓存读取量：`cache_read_input_tokens`。
   * 注意 Anthropic 另有 `cache_creation_input_tokens`（**写入**缓存，非命中），
   * 语义相反，不计入命中率——只取 read 字段。
   * @param raw 端点返回的 usage 对象（未知类型，内部逐层窄化）
   * @returns 命中 token 数；无法判定时为 undefined
   */
  public readAnthropic(raw: unknown): number | undefined {
    const usage = this.record(raw);
    if (usage === undefined) return undefined;
    return this.nonNegativeInt(usage['cache_read_input_tokens']);
  }

  /** 把未知值窄化为普通对象；非对象（含 null / 数组）返回 undefined。
   * @param raw 待窄化的任意值。
   * @returns 普通对象形态；不满足时为 undefined。
   */
  private record(raw: unknown): Record<string, unknown> | undefined {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
    return raw as Record<string, unknown>;
  }

  /** 把未知值窄化为非负整数；非有限数 / 负数 / 缺失一律返回 undefined（区分「未知」与 0）。
   * @param raw 待窄化的任意值。
   * @returns 四舍五入后的非负整数；无法判定时为 undefined（= 未知，语义上不同于 0）。
   */
  private nonNegativeInt(raw: unknown): number | undefined {
    if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0) return undefined;
    return Math.round(raw);
  }
}
