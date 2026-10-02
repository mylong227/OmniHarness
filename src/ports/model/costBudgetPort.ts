import type { ModelUsage, RoutePrice } from './model.js';
import type { BudgetSnapshot } from './budgetSnapshot.js';

/**
 * @beta
 * 会话级成本预算计量端口（#S29 / P5）。
 *
 * 无第三方依赖、进程内、按路由定价累计 token 成本：每次模型调用成功后 `record` 记账，
 * 一旦累计花费越过硬预算即置位熔断（`exceeded`），后续 `ensureWithin` 抛错（fail-closed）。
 *
 * 由 `adapters/model/costBudget.ts` 的 `CostBudget` 实现；`ResolvedConfig` 等经本端口持有预算，
 * 不再依赖 adapters 具体实现，解除 `ports→adapters` 禁边。
 */
export interface CostBudgetPort {
  /** 硬预算上限（USD）。 */
  readonly limitUsd: number;

  /**
   * 取模型定价：精确匹配 → 最长前缀匹配 → 兜底价。
   * @param model 模型标识（允许带版本后缀，前缀匹配取最长命中）。
   * @returns 命中的定价；无任何命中时返回兜底价（保证永不返回 undefined）。
   */
  priceFor(model: string): RoutePrice;

  /**
   * 记录一次模型调用的用量并累计成本（缓存命中按缓存价折抵，P5）；越阈值则置位标记并回调。
   * @param model 模型标识（用于查定价）。
   * @param usage 本次调用用量（输入/输出 token 数、可选缓存命中量）。
   * @returns 无返回值。
   */
  record(model: string, usage: ModelUsage): void;

  /**
   * 预算内断言（fail-closed）：已熔断且为阻断模式时抛错，阻断下一次模型调用；软预算（blocking=false）则为空操作。
   * @param model 即将调用的模型标识（写入错误消息便于定位）。
   * @returns 无返回值。
   */
  ensureWithin(model: string): void;

  /** 是否已越过硬预算。 */
  readonly exceeded: boolean;
  /** 是否已越过软阈值（P5）。 */
  readonly softExceeded: boolean;
  /** 是否建议降级（P5）。 */
  readonly degradeSuggested: boolean;
  /** 软阈值金额（P5）。 */
  readonly softLimitUsd: number;
  /** 累计花费（USD）。 */
  readonly totalCostUsd: number;
  /** 因缓存折抵少记的花费（P5）。 */
  readonly totalSavedUsd: number;
  /** 累计输入 token 数。 */
  readonly totalPromptTokens: number;
  /** 累计输出 token 数。 */
  readonly totalCompletionTokens: number;
  /** 累计命中缓存的 prompt token 数（P5）。 */
  readonly totalCachedPromptTokens: number;
  /** 剩余额度（USD，下限 0）。 */
  readonly remainingUsd: number;
  /** 当前预算快照。 */
  snapshot(): BudgetSnapshot;
}
