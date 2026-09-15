import type { ModelUsage, RoutePrice } from '../../ports/model/model.js';
import { BudgetExceededError } from '../../ports/model/model.js';
import { DEFAULT_FALLBACK_PRICE } from './routePricing.js';

/**
 * @beta
 * 软阈值默认比例（P5）：累计花费达到硬预算的该比例时置位软标记，
 * 供上层「降级」决策（缩检索预算 / 收敛工具使用）而非直接熔断。
 */
export const DEFAULT_SOFT_RATIO = 0.8;

/**
 * @beta
 * 预算快照（供 budget_status 工具与事件上报）。
 */
export interface BudgetSnapshot {
  /** 硬预算上限（USD）。 */
  readonly limitUsd: number;
  /** 已累计花费（USD）。 */
  readonly spentUsd: number;
  /** 剩余额度（USD，下限 0）。 */
  readonly remainingUsd: number;
  /** 累计输入 token 数（含命中缓存的 prompt token）。 */
  readonly totalPromptTokens: number;
  /** 累计输出 token 数。 */
  readonly totalCompletionTokens: number;
  /** 累计命中「提示缓存」的 prompt token 数（P5；只统计已上报命中量的调用）。 */
  readonly cachedPromptTokens: number;
  /** 因缓存折抵而少记的花费（USD，P5；未提供缓存价时为 0）。 */
  readonly savedUsd: number;
  /** 软阈值金额（USD）= `softRatio × limitUsd`。 */
  readonly softLimitUsd: number;
  /** 是否已越过软阈值（P5）。 */
  readonly softExceeded: boolean;
  /** 是否已越过硬预算（熔断标记）。 */
  readonly exceeded: boolean;
  /** 是否建议降级（P5）= 已越软阈值但尚未硬熔断。 */
  readonly degradeSuggested: boolean;
}

/**
 * @beta
 * 会话级成本预算计量（#S29 / P5）。
 *
 * 零依赖、进程内、按路由定价累计 token 成本：每次模型调用成功后 `record` 记账，
 * 一旦累计花费越过硬预算即置位熔断（`exceeded`），后续 `ensureWithin` 抛
 * `BudgetExceededError`（fail-closed，阻断下一次模型调用，防止失控烧钱）。
 *
 * P5 增补两点**口径修正**与**可观测性**：
 *  - **缓存折抵**：命中「提示缓存」的 prompt token 按 `cachedInputPer1M` 计价
 *    （缺该项则并入普通输入价，即不打折）。此前命中缓存与未命中同价，
 *    在长会话（前缀稳定、命中率高）会显著高估花费。只对**已上报**的命中量打折，
 *    缺值不臆造、且命中量按 `promptTokens` 截断防御。
 *  - **软阈值信号**：累计花费达 `softRatio × limitUsd` 时置位 `softExceeded`
 *    并回调 `onSoftExceed`，供上层**降级**（缩检索预算 / 收敛工具使用）而非直接熔断。
 *    本类只产出**信号**，不自行改变任何运行时旋钮。
 *
 * 注意：单次调用的 token 数只能事后得知，故超支幅度以「单次调用成本」为上界，
 * 不会无限放大；若要在首调前就严格禁支，请把 `limitUsd` 设为正数且接受一次调用的上界。
 */
export class CostBudget {
  /** 累计输入 token 数。 */
  private promptTokens = 0;
  /** 累计输出 token 数。 */
  private completionTokens = 0;
  /** 累计命中缓存的 prompt token 数（P5）。 */
  private cachedTokens = 0;
  /** 累计花费（USD，按路由定价折算）。 */
  private spentUsd = 0;
  /** 因缓存折抵少记的花费（USD，P5）。 */
  private savedUsdValue = 0;
  /** 熔断标记：累计花费越限后置 true（不可逆）。 */
  private exceededFlag = false;
  /** 软阈值标记：累计花费越过软阈值后置 true（不可逆）。 */
  private softFlag = false;
  /** 软阈值比例（已归一化到 (0,1]）。 */
  public readonly softRatio: number;

  public constructor(
    /** 硬预算上限（USD）。 */
    public readonly limitUsd: number,
    /** 路由定价表：模型名（或其前缀）→ 每百万 token 单价。 */
    private readonly pricing: ReadonlyMap<string, RoutePrice>,
    /** 未命中定价表时的兜底单价。 */
    private readonly fallback: RoutePrice = DEFAULT_FALLBACK_PRICE,
    /** 越硬预算回调（可选）：置位熔断时收到当前快照，供上层上报。 */
    private readonly onExceed?: (snapshot: BudgetSnapshot) => void,
    /** 是否阻断（fail-closed）：true（默认）越限抛错；false 为软预算，仅记账与标记、不阻断调用。 */
    public readonly blocking: boolean = true,
    /** 软阈值比例（相对硬预算，默认 {@link DEFAULT_SOFT_RATIO}）；非法值回落默认。 */
    softRatio: number = DEFAULT_SOFT_RATIO,
    /** 越软阈值回调（可选）：置位软标记时收到当前快照，供上层降级决策。 */
    private readonly onSoftExceed?: (snapshot: BudgetSnapshot) => void,
  ) {
    this.softRatio = CostBudget.normalizeSoftRatio(softRatio);
  }

  /** 取模型定价：精确匹配 → 最长前缀匹配 → 兜底价。
   * @param model 模型标识（允许带版本后缀，前缀匹配取最长命中）。
   * @returns 命中的定价；无任何命中时返回兜底价（保证永不返回 undefined）。
   */
  public priceFor(model: string): RoutePrice {
    const exact = this.pricing.get(model);
    if (exact !== undefined) {
      return exact;
    }
    let best: RoutePrice | undefined;
    let bestLen = -1;
    for (const [key, price] of this.pricing) {
      if (model.startsWith(key) && key.length > bestLen) {
        best = price;
        bestLen = key.length;
      }
    }
    return best ?? this.fallback;
  }

  /** 记录一次模型调用的用量并累计成本（缓存命中按缓存价折抵，P5）；越阈值则置位标记并回调。
   * @param model 模型标识（用于查定价）。
   * @param usage 本次调用用量（输入/输出 token 数、可选缓存命中量）。
   * @returns 无返回值。
   */
  public record(model: string, usage: ModelUsage): void {
    this.promptTokens += usage.promptTokens;
    this.completionTokens += usage.completionTokens;
    const price = this.priceFor(model);
    const cached = CostBudget.clampCached(usage.cachedPromptTokens, usage.promptTokens);
    this.cachedTokens += cached;
    const uncached = usage.promptTokens - cached;
    const cachedUnit = price.cachedInputPer1M ?? price.inputPer1M;
    const outputCost = (usage.completionTokens / 1_000_000) * price.outputPer1M;
    const cost =
      (uncached / 1_000_000) * price.inputPer1M + (cached / 1_000_000) * cachedUnit + outputCost;
    // 无缓存时的等价成本：仅用于量化「缓存省了多少」，不参与花费累计。
    const noCacheCost = (usage.promptTokens / 1_000_000) * price.inputPer1M + outputCost;
    this.savedUsdValue += Math.max(0, noCacheCost - cost);
    this.spentUsd += cost;
    this.markThresholds();
  }

  /** 预算内断言（fail-closed）：已熔断且为阻断模式时抛错，阻断下一次模型调用；软预算（blocking=false）则为空操作。
   * @param model 即将调用的模型标识（写入错误消息便于定位）。
   * @returns 无返回值。
   */
  public ensureWithin(model: string): void {
    if (!this.blocking || !this.exceededFlag) {
      return;
    }
    throw new BudgetExceededError(
      `成本硬预算已耗尽（$${this.spentUsd.toFixed(4)} / $${this.limitUsd.toFixed(4)}），阻断模型调用「${model}」`,
      { limitUsd: this.limitUsd, spentUsd: this.spentUsd, model },
    );
  }

  /** 是否已越过硬预算。
   * @returns 熔断标记（置位后不可逆）。
   */
  public get exceeded(): boolean {
    return this.exceededFlag;
  }

  /** 是否已越过软阈值（P5）。
   * @returns 软标记（置位后不可逆）。
   */
  public get softExceeded(): boolean {
    return this.softFlag;
  }

  /** 是否建议降级（P5）。
   * @returns 已越软阈值且尚未硬熔断时为 true。
   */
  public get degradeSuggested(): boolean {
    return this.softFlag && !this.exceededFlag;
  }

  /** 软阈值金额（P5）。
   * @returns `softRatio × limitUsd`（USD）。
   */
  public get softLimitUsd(): number {
    return this.softRatio * this.limitUsd;
  }

  /** 累计花费。
   * @returns 已花费金额（USD）。
   */
  public get totalCostUsd(): number {
    return this.spentUsd;
  }

  /** 因缓存折抵少记的花费（P5）。
   * @returns 省下的金额（USD）。
   */
  public get totalSavedUsd(): number {
    return this.savedUsdValue;
  }

  /** 累计输入 token 数。
   * @returns 所有已记账调用的输入 token 总和。
   */
  public get totalPromptTokens(): number {
    return this.promptTokens;
  }

  /** 累计输出 token 数。
   * @returns 所有已记账调用的输出 token 总和。
   */
  public get totalCompletionTokens(): number {
    return this.completionTokens;
  }

  /** 累计命中缓存的 prompt token 数（P5）。
   * @returns 已上报缓存命中量的调用之命中 token 总和。
   */
  public get totalCachedPromptTokens(): number {
    return this.cachedTokens;
  }

  /** 剩余额度。
   * @returns limit - spent，下限 0（越限后不为负）。
   */
  public get remainingUsd(): number {
    return Math.max(0, this.limitUsd - this.spentUsd);
  }

  /** 当前预算快照。
   * @returns 限额/已花/剩余/token 累计/缓存折抵/软硬阈值标记的完整快照（供工具与事件上报）。
   */
  public snapshot(): BudgetSnapshot {
    return {
      limitUsd: this.limitUsd,
      spentUsd: this.spentUsd,
      remainingUsd: this.remainingUsd,
      totalPromptTokens: this.promptTokens,
      totalCompletionTokens: this.completionTokens,
      cachedPromptTokens: this.cachedTokens,
      savedUsd: this.savedUsdValue,
      softLimitUsd: this.softLimitUsd,
      softExceeded: this.softFlag,
      exceeded: this.exceededFlag,
      degradeSuggested: this.degradeSuggested,
    };
  }

  /** 阈值检查：先软后硬，各自只触发一次回调（标记不可逆）。
   * @returns 无返回值。
   */
  private markThresholds(): void {
    const softLimit = this.softLimitUsd;
    if (!this.softFlag && softLimit > 0 && this.spentUsd >= softLimit) {
      this.softFlag = true;
      this.onSoftExceed?.(this.snapshot());
    }
    if (this.spentUsd >= this.limitUsd) {
      this.exceededFlag = true;
      this.onExceed?.(this.snapshot());
    }
  }

  /** 归一化软阈值比例到 (0,1]；非法值（NaN / ≤0 / >1）回落默认。
   * @param ratio 待归一化的比例。
   * @returns 合法比例。
   */
  private static normalizeSoftRatio(ratio: number): number {
    if (!Number.isFinite(ratio) || ratio <= 0 || ratio > 1) {
      return DEFAULT_SOFT_RATIO;
    }
    return ratio;
  }

  /** 把已上报的缓存命中量收窄到 [0, promptTokens]（防端点上报越界值破坏计价）。
   * @param cached 端点上报的缓存命中 token 数（未上报为 undefined）。
   * @param promptTokens 本次调用的输入 token 总数。
   * @returns 合法的缓存命中 token 数（未上报 / 非法一律记 0，即不打折）。
   */
  private static clampCached(cached: number | undefined, promptTokens: number): number {
    if (cached === undefined || !Number.isFinite(cached)) {
      return 0;
    }
    return Math.max(0, Math.min(cached, promptTokens));
  }
}
