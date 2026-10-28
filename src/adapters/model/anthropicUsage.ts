import type { ModelUsage } from '../../ports/model/model.ts';

/** 流式用量累积状态（字段与 wire 同形）。 */
export interface AnthropicUsageState {
  input_tokens?: number | undefined;
  output_tokens?: number | undefined;
  cache_creation_input_tokens?: number | undefined;
  cache_read_input_tokens?: number | undefined;
  stop_reason?: string | undefined;
  signature?: string | undefined;
}

/** wire 层 usage（非流式响应体与流式 message_start 同形）。 */
export interface AnthropicUsageWire {
  readonly input_tokens?: number | undefined;
  readonly output_tokens?: number | undefined;
  readonly cache_creation_input_tokens?: number | undefined;
  readonly cache_read_input_tokens?: number | undefined;
}

/** 流式事件中的用量字段（只取本模块需要的部分）。 */
export interface AnthropicUsageEvent {
  readonly message?: { readonly usage?: AnthropicUsageWire };
  readonly usage?: AnthropicUsageWire;
}

/**
 * Anthropic 用量合成与累积（2026-10-29 从 `AnthropicModel` 抽出，压体量阈值）。
 *
 * 口径：`promptTokens = input + cache_creation + cache_read`（Anthropic 的 input 不含缓存两段），
 * `cachedPromptTokens` 单列命中量，`cacheCreationPromptTokens` 单列写入量供成本按 1.25× 计价。
 */
export class AnthropicUsage {
  /**
   * 合成为统一用量。
   * @param raw 原始 usage。
   * @param cached 已解析的缓存命中量（由调用方的 promptCache 读取）。
   * @returns 统一用量；三段 input 全缺时为 undefined（不臆造 0）。
   */
  public static toModelUsage(
    raw: AnthropicUsageState | AnthropicUsageWire | undefined,
    cached: number | undefined,
  ): ModelUsage | undefined {
    if (raw === undefined) return undefined;
    const input = typeof raw.input_tokens === 'number' ? raw.input_tokens : undefined;
    const cacheCreate =
      typeof raw.cache_creation_input_tokens === 'number' ? raw.cache_creation_input_tokens : 0;
    if (input === undefined && cached === undefined && cacheCreate === 0) return undefined;
    const promptTokens = (input ?? 0) + cacheCreate + (cached ?? 0);
    const completionTokens = typeof raw.output_tokens === 'number' ? raw.output_tokens : 0;
    return {
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
      ...(cached === undefined ? {} : { cachedPromptTokens: cached }),
      ...(cacheCreate > 0 ? { cacheCreationPromptTokens: cacheCreate } : {}),
    };
  }

  /**
   * 从流式事件累积用量：`message_start` 给 input/cache 三段，`message_delta` 给 output（覆盖写）。
   * @param event 单个流式事件。
   * @param state 跨事件累积状态（原地更新）。
   * @returns 无返回值。
   */
  public static observe(event: AnthropicUsageEvent, state: AnthropicUsageState): void {
    const start = event.message?.usage;
    if (start !== undefined) {
      state.input_tokens = start.input_tokens ?? state.input_tokens;
      state.cache_creation_input_tokens =
        start.cache_creation_input_tokens ?? state.cache_creation_input_tokens;
      state.cache_read_input_tokens =
        start.cache_read_input_tokens ?? state.cache_read_input_tokens;
    }
    const delta = event.usage;
    if (delta !== undefined) {
      state.output_tokens = delta.output_tokens ?? state.output_tokens;
      state.input_tokens = delta.input_tokens ?? state.input_tokens;
    }
  }
}
