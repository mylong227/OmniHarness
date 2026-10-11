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
  /**
   * 本次记账里**未命中价目表**、按兜底价估算过的模型名（升序去重；空数组 = 全部命中价目表）。
   *
   * 判读方式：非空即表示 `spentUsd` 的**单价部分不可信**——兜底价（1.0/3.0，USD/百万 token）
   * 与真实单价可差数倍，且方向不定（高端档偏低 ⇒ 硬预算熔断过晚；廉价档偏高 ⇒ 熔断过早）。
   * 本字段不是"出错"，而是把"估算基于兜底价"这件事**从无声变成可见**：调用方应据此把
   * 成本数字标注为估算，或在关键场景补上真实价目（`routePricing` 的用户自定义表）。
   */
  readonly unpricedModels: readonly string[];
}
