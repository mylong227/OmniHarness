import type { RoutePrice } from '../../ports/model/model.js';

/**
 * @beta
 * 定价命中来源：`exact` 命中同名键、`prefix` 命中最长前缀键、`fallback` 未命中（用兜底价）。
 *
 * 为什么要把「来源」单列出来：兜底价（1.0/3.0）与真实单价可差**数倍**（实测：出货默认的
 * `claude-sonnet-4-*` 真价 3/15，兜底价把它低估 3×/5× ⇒ 成本硬预算会在**该熔断之后**才熔断）。
 * 只返回价格时这件事是无声的；返回来源，消费面才能如实自报「本次估算不可信」。
 */
export type PriceSource = 'exact' | 'prefix' | 'fallback';

/** 一次定价解析的结果（价格 + 命中的键 + 来源）。 */
export interface PriceResolution {
  /** 生效单价。 */
  readonly price: RoutePrice;
  /** 命中的价目表键；未命中（`fallback`）时为 null。 */
  readonly key: string | null;
  /** 命中来源。 */
  readonly source: PriceSource;
}

/**
 * RoutePricing —— 由本文件原顶层函数归并而来（每个方法对应一个原函数，语义与签名逐字保留）。
 */
export class RoutePricing {
  /**
   * @beta
   * 把用户自定义定价表叠到默认表之上（用户表优先）。
   */
  public static mergeRoutePricing(custom?: Record<string, RoutePrice>): Map<string, RoutePrice> {
    const merged = new Map<string, RoutePrice>();
    for (const [key, value] of Object.entries(DEFAULT_ROUTE_PRICING)) {
      merged.set(key, value);
    }
    if (custom !== undefined) {
      for (const [key, value] of Object.entries(custom)) {
        merged.set(key, value);
      }
    }
    return merged;
  }

  /**
   * @beta
   * 解析模型价目：精确匹配 → 最长前缀匹配 → 兜底价。**匹配规则只有这一处实现**。
   *
   * 抽取动机（防漂移）：此前「最长前缀」这段规则写在 `CostBudget.priceFor` 里，而"这个模型
   * 到底有没有价目"只能靠外部再写一遍同样的循环来猜——两处实现迟早漂移。现由本方法同时给出
   * 价格与来源，`CostBudget.priceFor` 退化为一行委派。
   * @param model 模型标识（允许带版本后缀，前缀匹配取最长命中）。
   * @param pricing 生效价目表。
   * @param fallback 未命中时的兜底价。
   * @returns 价格、命中的键（未命中为 null）与来源。
   */
  public static resolve(
    model: string,
    pricing: ReadonlyMap<string, RoutePrice>,
    fallback: RoutePrice,
  ): PriceResolution {
    const exact = pricing.get(model);
    if (exact !== undefined) {
      return { price: exact, key: model, source: 'exact' };
    }
    let best: RoutePrice | undefined;
    let bestKey: string | null = null;
    let bestLen = -1;
    for (const [key, price] of pricing) {
      if (model.startsWith(key) && key.length > bestLen) {
        best = price;
        bestKey = key;
        bestLen = key.length;
      }
    }
    if (best === undefined || bestKey === null) {
      return { price: fallback, key: null, source: 'fallback' };
    }
    return { price: best, key: bestKey, source: 'prefix' };
  }

  /**
   * @beta
   * 该模型是否命中了一条**明确的**未定价登记（出货默认族，见 {@link UNPRICED_DEFAULT_FAMILIES}）。
   *
   * 规则与价目表一致（最长前缀），故 `qwen-plus` 命中的是登记键 `qwen`。
   * @param model 模型标识。
   * @returns 命中的登记项（含理由）；未登记时为 null。
   */
  public static unpricedDefaultFor(model: string): UnpricedDefault | null {
    let best: UnpricedDefault | null = null;
    let bestLen = -1;
    for (const [key, reason] of Object.entries(UNPRICED_DEFAULT_FAMILIES)) {
      if (model.startsWith(key) && key.length > bestLen) {
        best = { key, reason };
        bestLen = key.length;
      }
    }
    return best;
  }
}

/** 一条「出货默认但无价目」的登记项。 */
export interface UnpricedDefault {
  /** 命中的登记键（模型名或前缀）。 */
  readonly key: string;
  /** 为什么不登记价格（必须写清"是查不到"还是"是零成本"）。 */
  readonly reason: string;
}

/**
 * @beta
 * 默认路由定价表（#S29，单位 USD / 百万 token）。
 * 仅供成本计量参考，非计费凭据；前缀匹配生效（如 `gpt-4o-2024-...` → `gpt-4o`）。
 *
 * `cachedInputPer1M`（P5）为「提示缓存命中」的输入单价，取自各家公开的 cache-read 档
 * （通常为未命中输入价的 10%–50%）；价格会漂移，此处仅为**计量参考**，非计费依据。
 * 缺该项即视为「无缓存价」⇒ 命中 token 按 `inputPer1M` 计（不打折）。
 *
 * **出货默认模型必须在表内或有明确登记**（判据 `routePricingDefaults.test.ts` 会读出
 * `defaults/providers.json`、`defaults/endpoints.json` 与 CLI 缺省模型逐个核对）——
 * 理由见 §「兜底价的方向性错误」：兜底价对 Anthropic 档位**偏低**，会让硬预算熔断过晚。
 */
export const DEFAULT_ROUTE_PRICING: Record<string, RoutePrice> = {
  'gpt-4o': { inputPer1M: 2.5, outputPer1M: 10, cachedInputPer1M: 1.25 },
  'gpt-4o-mini': { inputPer1M: 0.15, outputPer1M: 0.6, cachedInputPer1M: 0.075 },
  'gpt-4-turbo': { inputPer1M: 10, outputPer1M: 30, cachedInputPer1M: 5 },
  o1: { inputPer1M: 15, outputPer1M: 60, cachedInputPer1M: 7.5 },
  o3: { inputPer1M: 10, outputPer1M: 40, cachedInputPer1M: 2.5 },
  'deepseek-chat': { inputPer1M: 0.27, outputPer1M: 1.1, cachedInputPer1M: 0.07 },
  'deepseek-reasoner': { inputPer1M: 0.55, outputPer1M: 2.19, cachedInputPer1M: 0.14 },
  'claude-3-5-sonnet': { inputPer1M: 3, outputPer1M: 15, cachedInputPer1M: 0.3 },
  'claude-3-haiku': { inputPer1M: 0.25, outputPer1M: 1.25, cachedInputPer1M: 0.03 },
  'claude-3-opus': { inputPer1M: 15, outputPer1M: 75, cachedInputPer1M: 1.5 },
  // 出货默认的 Anthropic 两档（`defaults/providers.json` 的 anthropic 预设 models 列表）：
  // 与表内同档 3.x 行**同价**（同一公开价目档位），故不再单列新数字。
  // 缺这两行时 `claude-sonnet-4-20250514` 既不精确命中也不前缀命中 ⇒ 落兜底价 1.0/3.0，
  // 把 3/15 的真实单价低估 3×/5×（实测，2026-10-11）。
  'claude-sonnet-4': { inputPer1M: 3, outputPer1M: 15, cachedInputPer1M: 0.3 },
  'claude-opus-4': { inputPer1M: 15, outputPer1M: 75, cachedInputPer1M: 1.5 },
  llama: { inputPer1M: 0, outputPer1M: 0, cachedInputPer1M: 0 },
  local: { inputPer1M: 0, outputPer1M: 0, cachedInputPer1M: 0 },
  llamacpp: { inputPer1M: 0, outputPer1M: 0, cachedInputPer1M: 0 },
};

/**
 * @beta
 * 出货默认里**故意不登记价格**的模型族（键 = 模型名或前缀，匹配规则同价目表）。
 *
 * ## 这份登记表解决什么
 *
 * 兜底价的方向性错误：它既可能低估（Claude 档 3/15 ⇒ 低估 3×/5× ⇒ 硬预算**熔断过晚**），
 * 也可能高估（国产廉价档 ⇒ 熔断过早）。对**出货默认**而言，这两种都不可接受，而本仓
 * 离线拿不到可靠单价的模型又确实存在——所以这里不给"猜一个数字"，而是要求**逐个显出决策**：
 * 要么进价目表，要么进这张表并写明理由。判据会核对出货默认全部落在两者之一，
 * 新增厂商预设时若两边都没有，门禁当场变红（而不是静默按兜底价算钱）。
 *
 * ## 边界（诚实登记）
 *
 * 登记 ≠ 修正：这些族的成本估算**仍按兜底价**，只是运行期会经 `BudgetSnapshot.unpricedModels`
 * 与 `budget_status` 工具如实自报"本次估算的单价来自兜底价"。要真正修正，需要补上可核对的单价。
 */
export const UNPRICED_DEFAULT_FAMILIES: Readonly<Record<string, string>> = {
  'deepseek-v4':
    'DeepSeek 2026 新版主模型族（v4-flash / v4-pro / vision-exp）：本仓离线拿不到可复核的公开单价样本，不猜数字。',
  'kimi-k2': 'Moonshot Kimi K2 族：同上，无离线可复核的单价样本。',
  'moonshot-v1':
    'Moonshot 旧代 v1 族（8k/32k/128k）：按上下文长度分档计价，模型名不足以定档，需人补。',
  'glm-4': '智谱 GLM-4.5 族：无离线可复核的单价样本。',
  qwen: '通义千问族：同名模型既可能跑在 dashscope（付费）也可能跑在本地 ollama（边际成本≈0），模型名区分不了计费方 ⇒ **不按 0 计**（宁高勿低，避免本地/云端混用时低估）。',
  'gemini-2.5': 'Google Gemini 2.5 族：无离线可复核的单价样本。',
  'claude-3-5-haiku':
    'Anthropic 3.5 Haiku：与表内 claude-3-haiku 不同价（不可沿用同档行），暂无离线可核对来源。',
  'gpt-4.1': 'OpenAI GPT-4.1：与表内 gpt-4o 不同价（不可沿用同档行），暂无离线可核对来源。',
};

/**
 * @beta
 * 兜底定价（未知模型）：取中等价位，避免计费恒为 0 而漏熔断。
 *
 * ⚠️ 它不是"安全"值：对高端档位偏低（见 {@link UNPRICED_DEFAULT_FAMILIES} 的方向性说明）。
 */
export const DEFAULT_FALLBACK_PRICE: RoutePrice = {
  inputPer1M: 1.0,
  outputPer1M: 3.0,
  cachedInputPer1M: 0.5,
};
