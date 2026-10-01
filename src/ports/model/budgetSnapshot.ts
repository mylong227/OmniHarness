/**
 * @beta
 * 预算快照（供 budget_status 工具与事件上报）。
 *
 * 原定义于 `adapters/model/costBudget.ts`，随 `CostBudgetPort` 一同外迁至 ports 层，
 * 使预算端口契约不再依赖 adapters 具体实现。
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
