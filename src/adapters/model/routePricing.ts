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
  // ── 2026-10-11：出货默认族里此前"只有登记、没有价目"的批次，按**公开价目**填入真实单价 ──
  // 来源与核对方式见 PRICE_SOURCES（固定到 blob SHA，可复核）；无来源的三个族仍留在
  // UNPRICED_DEFAULT_FAMILIES 并写明"查过什么、为什么仍不猜"。
  // DeepSeek 直连（v4 三档；vision-exp 与 flash 同价）
  'deepseek-v4-flash': { inputPer1M: 0.3, outputPer1M: 1.2, cachedInputPer1M: 0.006 },
  'deepseek-v4-flash-vision-exp': { inputPer1M: 0.3, outputPer1M: 1.2, cachedInputPer1M: 0.006 },
  'deepseek-v4-pro': { inputPer1M: 1.32, outputPer1M: 3.96, cachedInputPer1M: 0.044 },
  // Moonshot v1：**按上下文长度分三档**（正是旧登记里说"模型名不足以定档"的那一族）
  'moonshot-v1-8k': { inputPer1M: 0.2, outputPer1M: 2 },
  'moonshot-v1-32k': { inputPer1M: 1, outputPer1M: 3 },
  'moonshot-v1-128k': { inputPer1M: 2, outputPer1M: 5 },
  // 智谱 GLM（zai 直连）；flash 档公开价为 0（免费档）
  'glm-4.5': { inputPer1M: 0.6, outputPer1M: 2.2 },
  'glm-4.5-air': { inputPer1M: 0.2, outputPer1M: 1.1 },
  'glm-4.5-flash': { inputPer1M: 0, outputPer1M: 0 },
  // 通义千问**云端明确档位**（dashscope）：只给明确档位定价，裸前缀仍留登记
  // （同名模型可能跑在本地 ollama ⇒ 边际成本≈0，模型名区分不了计费方）。
  'qwen-max': { inputPer1M: 1.6, outputPer1M: 6.4 },
  'qwen-plus': { inputPer1M: 0.4, outputPer1M: 1.2 },
  'qwen-turbo': { inputPer1M: 0.05, outputPer1M: 0.2 },
  // Google Gemini 2.5（三档，均带缓存读价）
  'gemini-2.5-pro': { inputPer1M: 1.25, outputPer1M: 10, cachedInputPer1M: 0.125 },
  'gemini-2.5-flash': { inputPer1M: 0.3, outputPer1M: 2.5, cachedInputPer1M: 0.03 },
  'gemini-2.5-flash-lite': { inputPer1M: 0.1, outputPer1M: 0.4, cachedInputPer1M: 0.01 },
  // Anthropic 3.5 Haiku（与表内 claude-3-haiku **不同价**，故必须单列）
  'claude-3-5-haiku': { inputPer1M: 0.8, outputPer1M: 4, cachedInputPer1M: 0.08 },
  // OpenAI GPT-4.1（与表内 gpt-4o 不同价）
  'gpt-4.1': { inputPer1M: 2, outputPer1M: 8, cachedInputPer1M: 0.5 },
  // ── 2026-10-15：Moonshot 出货预设迁移到**现役**型号后的定价（原 5 个型号已被厂商下线）──
  // 来源同 PRICE_SOURCES 的第二条快照（厂商直连条目 `moonshot/*`，USD/1M）。
  // 注：`kimi-k2.7-code` 是 `kimi-k2.7-code-highspeed` 的前缀 ⇒ 未定价的高速档会**前缀命中**这一行
  // （0.95/4.00，而高速档真价约 1.90/8.00）：比兜底价 1.0/3.0 更接近真价，方向仍是"偏低但更小"，
  // 已在 PRICE_SOURCES 的 note 里写明这处边界。
  'kimi-k2.6': { inputPer1M: 0.95, outputPer1M: 4, cachedInputPer1M: 0.16 },
  'kimi-k2.7-code': { inputPer1M: 0.95, outputPer1M: 4, cachedInputPer1M: 0.19 },
  'kimi-k3': { inputPer1M: 3, outputPer1M: 15, cachedInputPer1M: 0.3 },
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
  // 2026-10-11：原先登记 8 个族，本轮把**查得到公开价目**的都填进了 DEFAULT_ROUTE_PRICING
  // （deepseek-v4 / moonshot-v1 / glm-4.5 / gemini-2.5 / claude-3-5-haiku / gpt-4.1 /
  // qwen 云端明确档位）。剩下这几个仍**不给数字**，理由更新为「实际查过什么」：
  //
  // 2026-10-15 复核：原 `kimi-k2` 登记项**已删除**——厂商模型列表页明文写着 k2 系列
  // （含 kimi-k2-turbo-preview / kimi-k2-0905-preview）已于 2026-05-25 下线、moonshot-v1 系列
  // 已于 2026-08-31 下线 ⇒ 它们**不再出货**（`defaults/providers.json` 的 moonshot 预设已迁移到
  // kimi-k2.6 / kimi-k2.7-code / kimi-k3，三者都有厂商直连单价）。"不定价"的前提是没有现役型号，
  // 而不是给一个已下线的名字留一条理由——留着会让判据③（登记项必须被出货模型命中）失真。
  'glm-4-plus':
    '智谱 GLM-4-plus：① 官方模型概览页的**现役 9 款核心模型**里没有它（现役为 GLM-5.3 / 5.3-Flash / ' +
    '5.3-FlashX / 5.2 等），属上一代；② 官方 GLM-4 文档页虽给出「5 元 / 百万 Tokens」，但那是**人民币**' +
    '且是**单档数字**，而本表口径是 **USD / 百万 token 且分输入与输出**——两者不可直接换算（要引入汇率' +
    '假设，且缺输出价）⇒ 不猜数字。',
  'qwen3-coder-plus':
    '通义 qwen3-coder-plus：聚合价目库（坐标见 PRICE_SOURCES）里**有条目但成本字段为空**' +
    '（`dashscope/qwen3-coder-plus` 与 `...-2025-07-22` 两条的 in/out 均无值；同一批的 ' +
    '`qwen3-coder-flash` 亦然）⇒ 库侧没有可用数字，官方 dashscope 计费页为 JS 渲染、本机取不到正文 ⇒ 不猜。',
  qwen:
    '裸前缀 qwen：同名模型既可能跑在 dashscope（付费）也可能跑在本地 ollama（边际成本≈0），' +
    '模型名区分不了计费方 ⇒ **不按 0 计**（宁高勿低）。注意：明确档位（qwen-max / qwen-plus /' +
    'qwen-turbo）已有真实单价并落在价目表；本键只兜住「只写了 qwen 且无法定档」的名字。',
};

/**
 * 价目来源登记（2026-10-11）：给本轮新填的单价留一条**可复核**的来源。
 *
 * ## 为什么固定到 blob SHA
 *
 * 公开价目页会改；只写「来自某网站」无法复核。这里记的是 GitHub API 的 git blob 引用
 * （`/git/blobs/<sha>`）——同一个 SHA 的内容**逐字节不变**，任何人可复算。
 *
 * ## 来源口径（诚实登记）
 *
 * 本机环境里**厂商官方定价页不可达**，实测：
 *  · `platform.openai.com/docs/pricing` → HTTP 403（Cloudflare 拦截）；
 *  · `ai.google.dev/gemini-api/docs/pricing` → fetch failed；
 *  · `raw.githubusercontent.com` 直取亦失败（早前轮次已记录）。
 * 故本轮用**公开聚合价目库** LiteLLM 的 `model_prices_and_context_window.json`，并逐条取
 * **厂商直连条目**（`litellm_provider` 为 deepseek / moonshot / zai / dashscope / gemini / openai
 * 的那一条），而不是转售档（azure / bedrock / fireworks 等）。
 * 例外一处已在 note 里注明：3.5 Haiku 在库里**没有 anthropic 直连条目**，取的是同型号 id 的
 * bedrock 档（0.8/4.0，与厂商公开价一致，但来源是转售档）。
 *
 * 这不是「权威来源」，是**可复核来源**；官方页可达时应替换并更新本登记。
 */
export const PRICE_SOURCES: Readonly<
  Record<string, { readonly ref: string; readonly note: string }>
> = {
  '2026-10-11-litellm-snapshot': {
    // 取回方式（地址写在注释里：`src/**` 的**代码行**不得出现硬编码地址，见
    // `tests/unit/endpointDefaults.test.ts` ⑤ 反硬编码守卫）：
    //   https://api.github.com/repos/BerriAI/litellm/git/blobs/780adab42ab7e028f2e04faf8b68b67af4dc3813
    ref: 'repo:BerriAI/litellm@780adab42ab7e028f2e04faf8b68b67af4dc3813#path=model_prices_and_context_window.json',
    note:
      'LiteLLM model_prices_and_context_window.json（4042 条）。取厂商直连条目：' +
      'deepseek(flash 0.30/1.20 cache 0.006；pro 1.32/3.96 cache 0.044)、' +
      'moonshot(moonshot-v1 8k/32k/128k = 0.20/2.00、1.00/3.00、2.00/5.00)、' +
      'zai(glm-4.5 0.60/2.20；air 0.20/1.10；flash 0/0)、' +
      'dashscope(qwen-max 1.60/6.40；plus 0.40/1.20；turbo 0.05/0.20)、' +
      'gemini(2.5-pro 1.25/10 cache 0.125；flash 0.30/2.50 cache 0.03；' +
      'flash-lite 0.10/0.40 cache 0.01)、openai(gpt-4.1 2.00/8.00 cache 0.50)、' +
      'bedrock(claude-3-5-haiku 0.80/4.00 cache 0.08 —— 见上方「例外一处」)。',
  },
  '2026-10-15-litellm-snapshot': {
    // 取回方式（地址写在注释里：`src/**` 的**代码行**不得出现硬编码地址）：
    //   https://api.github.com/repos/BerriAI/litellm/git/blobs/1cdad96a076fcf035ce39184a42835ff3ba8fe98
    ref: 'repo:BerriAI/litellm@1cdad96a076fcf035ce39184a42835ff3ba8fe98#path=model_prices_and_context_window.json',
    note:
      'LiteLLM model_prices_and_context_window.json（4125 条；源提交 71e508b65dc4246f059777836f8ebe12f6ecf3a7）。' +
      '**厂商直连复核**：2026-10-11 那批 17 个键逐项重查，**数值与旧快照完全一致**（deepseek-v4 flash 0.30/1.20 ' +
      'cache 0.006、pro 1.32/3.96 cache 0.044；moonshot-v1 8k/32k/128k = 0.20/2.00、1.00/3.00、2.00/5.00；' +
      'zai glm-4.5 0.60/2.20、air 0.20/1.10、flash 0/0；dashscope qwen-max 1.60/6.40、plus 0.40/1.20、' +
      'turbo 0.05/0.20；gemini 2.5-pro 1.25/10 cache 0.125、flash 0.30/2.50 cache 0.03、flash-lite 0.10/0.40 ' +
      'cache 0.01；gpt-4.1 2.00/8.00 cache 0.50），故旧条目仍有效、本条目是**复核与新增**。' +
      '新增三个 Moonshot 现役型号的厂商直连价（`moonshot/*`）：kimi-k2.6 0.95/4.00 cache 0.16、' +
      'kimi-k2.7-code 0.95/4.00 cache 0.19、kimi-k3 3.00/15.00 cache 0.30。' +
      '**边界一处**：`kimi-k2.7-code-highspeed` 无厂商直连条目（仅转售档）⇒ 不进预设、不单独定价，' +
      '它会**前缀命中** kimi-k2.7-code 那一行（真价约 1.90/8.00，故仍属偏低但比兜底价更接近）。' +
      '**唯一例外仍是 3.5 Haiku**（旧条目已注明：库里无 anthropic 直连条目，取 bedrock 同型号档）。',
  },
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
