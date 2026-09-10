import type { ModelUsage, RoutePrice } from '../../ports/model.js';
import { BudgetExceededError } from '../../ports/model.js';
import { DEFAULT_FALLBACK_PRICE } from './routePricing.js';

/**
 * @beta
 * 预算快照（供 budget_status 工具与事件上报）。
 */
export interface BudgetSnapshot {
  readonly limitUsd: number;
  readonly spentUsd: number;
  readonly remainingUsd: number;
  readonly totalPromptTokens: number;
  readonly totalCompletionTokens: number;
  readonly exceeded: boolean;
}

/**
 * @beta
 * 会话级成本预算计量（#S29）。
 *
 * 零依赖、进程内、按路由定价累计 token 成本：每次模型调用成功后 `record` 记账，
 * 一旦累计花费越过硬预算即置位熔断（`exceeded`），后续 `ensureWithin` 抛
 * `BudgetExceededError`（fail-closed，阻断下一次模型调用，防止失控烧钱）。
 *
 * 注意：单次调用的 token 数只能事后得知，故超支幅度以「单次调用成本」为上界，
 * 不会无限放大；若要在首调前就严格禁支，请把 `limitUsd` 设为正数且接受一次调用的上界。
 */
export class CostBudget {
  private promptTokens = 0;
  private completionTokens = 0;
  private spentUsd = 0;
  private exceededFlag = false;

  public constructor(
    /** 硬预算上限（USD）。 */
    public readonly limitUsd: number,
    private readonly pricing: ReadonlyMap<string, RoutePrice>,
    private readonly fallback: RoutePrice = DEFAULT_FALLBACK_PRICE,
    private readonly onExceed?: (snapshot: BudgetSnapshot) => void,
    /** 是否阻断（fail-closed）：true（默认）越限抛错；false 为软预算，仅记账与标记、不阻断调用。 */
    public readonly blocking: boolean = true,
  ) {}

  /** 取模型定价：精确匹配 → 最长前缀匹配 → 兜底价。 */
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

  /** 记录一次模型调用的用量并累计成本；越过硬预算则置位熔断并回调。 */
  public record(model: string, usage: ModelUsage): void {
    this.promptTokens += usage.promptTokens;
    this.completionTokens += usage.completionTokens;
    const price = this.priceFor(model);
    const cost =
      (usage.promptTokens / 1_000_000) * price.inputPer1M +
      (usage.completionTokens / 1_000_000) * price.outputPer1M;
    this.spentUsd += cost;
    if (this.spentUsd >= this.limitUsd) {
      this.exceededFlag = true;
      this.onExceed?.(this.snapshot());
    }
  }

  /** 预算内断言（fail-closed）：已熔断且为阻断模式时抛错，阻断下一次模型调用；软预算（blocking=false）则为空操作。 */
  public ensureWithin(model: string): void {
    if (!this.blocking || !this.exceededFlag) {
      return;
    }
    throw new BudgetExceededError(
      `成本硬预算已耗尽（$${this.spentUsd.toFixed(4)} / $${this.limitUsd.toFixed(4)}），阻断模型调用「${model}」`,
      { limitUsd: this.limitUsd, spentUsd: this.spentUsd, model },
    );
  }

  public get exceeded(): boolean {
    return this.exceededFlag;
  }

  public get totalCostUsd(): number {
    return this.spentUsd;
  }

  public get totalPromptTokens(): number {
    return this.promptTokens;
  }

  public get totalCompletionTokens(): number {
    return this.completionTokens;
  }

  public get remainingUsd(): number {
    return Math.max(0, this.limitUsd - this.spentUsd);
  }

  /** 当前预算快照。 */
  public snapshot(): BudgetSnapshot {
    return {
      limitUsd: this.limitUsd,
      spentUsd: this.spentUsd,
      remainingUsd: this.remainingUsd,
      totalPromptTokens: this.promptTokens,
      totalCompletionTokens: this.completionTokens,
      exceeded: this.exceededFlag,
    };
  }
}
