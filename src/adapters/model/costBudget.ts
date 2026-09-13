import type { ModelUsage, RoutePrice } from '../../ports/model.js';
import { BudgetExceededError } from '../../ports/model.js';
import { DEFAULT_FALLBACK_PRICE } from './routePricing.js';

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
  /** 累计输入 token 数。 */
  readonly totalPromptTokens: number;
  /** 累计输出 token 数。 */
  readonly totalCompletionTokens: number;
  /** 是否已越过硬预算（熔断标记）。 */
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
  /** 累计输入 token 数。 */
  private promptTokens = 0;
  /** 累计输出 token 数。 */
  private completionTokens = 0;
  /** 累计花费（USD，按路由定价折算）。 */
  private spentUsd = 0;
  /** 熔断标记：累计花费越限后置 true（不可逆）。 */
  private exceededFlag = false;

  public constructor(
    /** 硬预算上限（USD）。 */
    public readonly limitUsd: number,
    /** 路由定价表：模型名（或其前缀）→ 每百万 token 单价。 */
    private readonly pricing: ReadonlyMap<string, RoutePrice>,
    /** 未命中定价表时的兜底单价。 */
    private readonly fallback: RoutePrice = DEFAULT_FALLBACK_PRICE,
    /** 越限回调（可选）：置位熔断时收到当前快照，供上层上报。 */
    private readonly onExceed?: (snapshot: BudgetSnapshot) => void,
    /** 是否阻断（fail-closed）：true（默认）越限抛错；false 为软预算，仅记账与标记、不阻断调用。 */
    public readonly blocking: boolean = true,
  ) {}

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

  /** 记录一次模型调用的用量并累计成本；越过硬预算则置位熔断并回调。
   * @param model 模型标识（用于查定价）。
   * @param usage 本次调用用量（输入/输出 token 数）。
   
 * @returns 无返回值。
*/
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

  /** 累计花费。
   * @returns 已花费金额（USD）。
   */
  public get totalCostUsd(): number {
    return this.spentUsd;
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

  /** 剩余额度。
   * @returns limit - spent，下限 0（越限后不为负）。
   */
  public get remainingUsd(): number {
    return Math.max(0, this.limitUsd - this.spentUsd);
  }

  /** 当前预算快照。
   * @returns 限额/已花/剩余/token 累计与熔断标记的完整快照（供工具与事件上报）。
   */
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
