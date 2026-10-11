/**
 * 推理强度的**跨 provider 映射**（单一实现，2026-10-11，目标项「跨 provider reasoning 档」）。
 *
 * ## 修之前是什么样子（实测）
 *
 * `ModelRequest.reasoningEffort` 只在 `openAiCompatibleModel` 里被透传成 `reasoning_effort`；
 * **Responses / Anthropic / Ollama 三条通路完全忽略它** —— 调用方写 `--reasoning-effort high`，
 * 在那三家上等于**什么都没发生**（静默失效，比报错更难查）。审计记的"跨 provider reasoning 档"
 * 指的就是这件事。
 *
 * ## 四家的落点（形态差异必须由适配器各自落实）
 *
 * | 上游 | 落点 |
 * | --- | --- |
 * | OpenAI Chat Completions 兼容 | `reasoning_effort: <原样字符串>`（**保持原语义**：本仓明确不做模型名猜测） |
 * | OpenAI Responses API | `reasoning: { effort: <原样字符串> }` |
 * | Anthropic Messages | `thinking: { type: 'enabled', budget_tokens: N }`（档位→预算见 {@link ModelReasoningEfforts.ANTHROPIC_BUDGETS}） |
 * | Ollama（llama.cpp 通路） | `think: true`（非"关"档；Ollama 的 HTTP 面只有布尔） |
 *
 * ## 两条硬约束（都比"尽力而为"更重要）
 *
 * 1. **Anthropic 要求 `max_tokens > budget_tokens`**，否则请求被拒。故 {@link ModelReasoningEfforts.anthropicMaxTokens}
 *    给出"为容纳该预算至少需要的 max_tokens"，由适配器取 `max(配置值, 该值)`。
 * 2. **未知档位在 Anthropic 侧 fail-closed**：OpenAI 的 `reasoning_effort` 是自由字符串（服务端自己判定），
 *    但 Anthropic 必须换算成一个**具体 token 预算**——猜一个数字等于把"用户要高强度推理"悄悄降级。
 *    故未登记的档位直接抛错并列出可接受取值。
 */

/** 推理档位（**与 `configError` 的 `reasoning` 枚举逐字一致**；由判据交叉核对，防两侧漂移）。 */
export type ReasoningLevel = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/** 各通路的线体片段工厂。 */
export class ModelReasoningEfforts {
  /**
   * Anthropic 的档位→思考预算（token）。
   *
   * 口径说明（为什么是这些数字）：**不是**逐字抄录某家文档，而是"本仓档位 → 一个具体预算"的换算表，
   * 取值落在 Anthropic 允许的区间内（预算 ≥ 1024 且必须小于 `max_tokens`，见
   * {@link ModelReasoningEfforts.anthropicMaxTokens}），并保证**随档位单调递增**。
   * `none` 不在表里 ⇒ 该档**不下发** `thinking` 字段（等于关掉扩展思考）。
   *
   * ⚠️ 覆盖范围必须与配置枚举一致：`configError` 的 `reasoning` 允许
   * `none | minimal | low | medium | high | xhigh | max`。本表若漏档，用户设了**合法**配置却会在
   * Anthropic 通路抛错（2026-10-11 实测踩到：初版只覆盖 4 档 ⇒ `xhigh` 直接抛）。
   */
  public static readonly ANTHROPIC_BUDGETS: Readonly<
    Record<Exclude<ReasoningLevel, 'none'>, number>
  > = {
    // Anthropic 要求 budget_tokens ≥ 1024。
    minimal: 1024,
    low: 2048,
    medium: 8192,
    high: 16_384,
    xhigh: 24_576,
    max: 32_768,
  };

  /** 6 档预算（`none` 除外）的升序序列，供判据核对单调性。 */
  public static readonly ANTHROPIC_BUDGET_ORDER: readonly number[] = [
    1024, 2048, 8192, 16_384, 24_576, 32_768,
  ];

  /** "不算开启推理"的档位（这些档在 Ollama 侧要显式 `think: false`）。 */
  private static readonly OFF_LEVELS: ReadonlySet<string> = new Set(['none', 'off', 'minimal']);

  /**
   * OpenAI Chat Completions 的 `reasoning_effort` 片段。
   *
   * @param effort 推理强度（未设或空串＝不发）。
   * @returns 线体片段；未设/空串时为 `undefined`。
   */
  public static toOpenAiChat(effort?: string): Record<string, unknown> | undefined {
    if (typeof effort !== 'string' || effort === '') return undefined;
    return { reasoning_effort: effort };
  }

  /**
   * OpenAI Responses API 的 `reasoning` 片段。
   *
   * @param effort 推理强度。
   * @returns 线体片段；未设/空串时为 `undefined`。
   */
  public static toResponses(effort?: string): Record<string, unknown> | undefined {
    if (typeof effort !== 'string' || effort === '') return undefined;
    return { reasoning: { effort } };
  }

  /**
   * Anthropic 的 `thinking` 片段。
   *
   * @param effort 推理强度（必须是已登记的档位之一）。
   * @returns 线体片段；未设/空串时为 `undefined`。
   * @throws Error 档位未登记（fail-closed，理由见类文档）。
   */
  public static toAnthropic(effort?: string): Record<string, unknown> | undefined {
    const budget = ModelReasoningEfforts.anthropicBudget(effort);
    if (budget === undefined) return undefined;
    return { thinking: { type: 'enabled', budget_tokens: budget } };
  }

  /**
   * 给定档位所需的最小 `max_tokens`（Anthropic 要求 `max_tokens > budget_tokens`）。
   *
   * @param effort 推理强度。
   * @param configured 配置里的 max_tokens（可能未设）。
   * @returns 实际应发送的 max_tokens。
   */
  public static anthropicMaxTokens(effort: string | undefined, configured?: number): number {
    const fallback = configured ?? 4096;
    const budget = ModelReasoningEfforts.anthropicBudget(effort);
    if (budget === undefined) return fallback;
    // 预算 + 一段输出余量（预算本身只是"思考"部分，还得留出正式回答的空间）。
    return Math.max(fallback, budget + 1024);
  }

  /**
   * Ollama 的 `think` 片段。
   *
   * @param effort 推理强度。
   * @returns `{think: boolean}`；未设/空串时为 `undefined`（尊重上游默认）。
   */
  public static toOllama(effort?: string): Record<string, unknown> | undefined {
    if (typeof effort !== 'string' || effort === '') return undefined;
    return { think: !ModelReasoningEfforts.OFF_LEVELS.has(effort) };
  }

  /**
   * 档位 → Anthropic 预算。
   *
   * @param effort 推理强度。
   * @returns 预算；未设/空串时为 `undefined`。
   * @throws Error 档位未登记。
   */
  private static anthropicBudget(effort?: string): number | undefined {
    if (typeof effort !== 'string' || effort === '') return undefined;
    // `none` 是**合法配置**且语义明确：不下发 thinking（不是"未知档位"）。
    if (effort === 'none') return undefined;
    const budget = (ModelReasoningEfforts.ANTHROPIC_BUDGETS as Record<string, number | undefined>)[
      effort
    ];
    if (budget === undefined) {
      throw new Error(
        `Anthropic 无法把 reasoningEffort=${JSON.stringify(effort)} 映射成思考预算；` +
          `可接受取值：none | ${Object.keys(ModelReasoningEfforts.ANTHROPIC_BUDGETS).join(' | ')}` +
          '（Anthropic 必须换算成具体 token 预算，猜一个数字等于静默降级）',
      );
    }
    return budget;
  }
}
