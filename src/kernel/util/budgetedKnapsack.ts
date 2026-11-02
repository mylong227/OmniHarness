/**
 * 0/1 背包选择器（预算内的最优子集）。
 *
 * ## 为什么不是「按分数从高到低贪心」
 *
 * 贪心在「高价值但很贵」的项上会提前吃掉预算，之后的小项装不进来；而 0/1 背包在当前
 * 规模（技能条数 ≤ 数十、预算 ≤ 1.2 万字符）可以用 **O(n·B)** 动态规划拿到**精确最优**：
 *
 * ```text
 * dp[i][b] = max(dp[i-1][b], dp[i-1][b-w_i] + v_i)
 * ```
 *
 * 规模保护：`n·B > 5e6` 时退回按 `v/w` 贪心（避免一次异常配置把主流程拖住）。
 *
 * @maturity L2 — 真实 0/1 DP + 规模回退；未做多维背包/分数预算
 * @maturityEvidence tests/unit/budgetedKnapsack.test.ts
 */

/** 背包项。 */
export interface KnapsackItem {
  /** 稳定 id（诊断用）。 */
  readonly id: string;
  /** 重量/成本（非负整数）。 */
  readonly weight: number;
  /** 价值。 */
  readonly value: number;
}

/** 选择结果。 */
export interface KnapsackSelection {
  /** 选中项在输入数组中的下标（升序）。 */
  readonly indices: readonly number[];
  /** 总价值。 */
  readonly value: number;
  /** 总重量。 */
  readonly weight: number;
}

/** 0/1 背包选择器（无状态）。 */
export class BudgetedKnapsack {
  /** DP 单元上限（超过则贪心回退）。 */
  private static readonly MAX_CELLS = 5_000_000;

  /**
   * 选预算内的最优子集。
   * @param items 项。
   * @param capacity 预算（非负整数）。
   * @param atLeastOne 无任何项装得下时，是否保留价值最高的一项（可能超预算）。
   * @returns 选择结果。
   */
  public static select(
    items: readonly KnapsackItem[],
    capacity: number,
    atLeastOne = false,
  ): KnapsackSelection {
    const budget = Math.max(0, Math.floor(capacity));
    const eligible = items
      .map((item, index) => ({ item, index }))
      .filter(
        ({ item }) => Number.isFinite(item.value) && item.weight > 0 && item.weight <= budget,
      );
    if (eligible.length === 0) {
      const fallback = BudgetedKnapsack.bestSingle(items);
      return fallback === undefined
        ? { indices: [], value: 0, weight: 0 }
        : atLeastOne
          ? { indices: [fallback.index], value: fallback.item.value, weight: fallback.item.weight }
          : { indices: [], value: 0, weight: 0 };
    }
    if (eligible.length * (budget + 1) > BudgetedKnapsack.MAX_CELLS) {
      return BudgetedKnapsack.greedy(eligible, budget, atLeastOne);
    }
    return BudgetedKnapsack.dynamic(eligible, budget, atLeastOne);
  }

  /**
   * 二维 DP + 回溯。
   * @param eligible 可装项（带原下标）。
   * @param capacity 预算。
   * @param atLeastOne 是否至少一项。
   * @returns 选择结果。
   */
  private static dynamic(
    eligible: readonly { readonly item: KnapsackItem; readonly index: number }[],
    capacity: number,
    atLeastOne: boolean,
  ): KnapsackSelection {
    const n = eligible.length;
    const width = capacity + 1;
    const dp = new Float64Array((n + 1) * width);
    for (let i = 1; i <= n; i += 1) {
      const { item } = eligible[i - 1]!;
      for (let b = 0; b <= capacity; b += 1) {
        const skip = dp[(i - 1) * width + b] ?? 0;
        const take =
          b >= item.weight
            ? (dp[(i - 1) * width + (b - item.weight)] ?? 0) + item.value
            : -Infinity;
        dp[i * width + b] = Math.max(skip, take);
      }
    }
    let bestWeight = 0;
    let bestValue = dp[n * width] ?? 0;
    for (let b = 1; b <= capacity; b += 1) {
      const value = dp[n * width + b] ?? 0;
      if (value > bestValue) {
        bestValue = value;
        bestWeight = b;
      }
    }
    const indices: number[] = [];
    let b = bestWeight;
    for (let i = n; i >= 1; i -= 1) {
      const item = eligible[i - 1]!.item;
      const skip = dp[(i - 1) * width + b] ?? 0;
      const current = dp[i * width + b] ?? 0;
      if (b >= item.weight && Math.abs(current - skip) > 0) {
        indices.push(eligible[i - 1]!.index);
        b -= item.weight;
      }
    }
    if (indices.length === 0 && atLeastOne) {
      const fallback = BudgetedKnapsack.bestSingle(eligible.map((entry) => entry.item));
      if (fallback !== undefined) {
        return {
          indices: [eligible[fallback.index]!.index],
          value: fallback.item.value,
          weight: fallback.item.weight,
        };
      }
    }
    return {
      indices: indices.reverse(),
      value: bestValue,
      weight: bestWeight,
    };
  }

  /**
   * 规模回退：按价值密度贪心，再尝试补齐。
   * @param eligible 可装项。
   * @param capacity 预算。
   * @param atLeastOne 是否至少一项。
   * @returns 选择结果。
   */
  private static greedy(
    eligible: readonly { readonly item: KnapsackItem; readonly index: number }[],
    capacity: number,
    atLeastOne: boolean,
  ): KnapsackSelection {
    const sorted = [...eligible].sort(
      (a, b) =>
        b.item.value / b.item.weight - a.item.value / a.item.weight ||
        b.item.value - a.item.value ||
        a.index - b.index,
    );
    const indices: number[] = [];
    let weight = 0;
    let value = 0;
    for (const { item, index } of sorted) {
      if (weight + item.weight <= capacity) {
        indices.push(index);
        weight += item.weight;
        value += item.value;
      }
    }
    if (indices.length === 0 && atLeastOne && sorted[0] !== undefined) {
      return {
        indices: [sorted[0].index],
        value: sorted[0].item.value,
        weight: sorted[0].item.weight,
      };
    }
    return { indices: indices.sort((a, b) => a - b), value, weight };
  }

  /**
   * 价值最高的单项。
   * @param items 项。
   * @returns 项与下标；空数组为 undefined。
   */
  private static bestSingle(
    items: readonly KnapsackItem[],
  ): { readonly item: KnapsackItem; readonly index: number } | undefined {
    let best: { item: KnapsackItem; index: number } | undefined;
    for (let i = 0; i < items.length; i += 1) {
      const item = items[i];
      if (item === undefined || !Number.isFinite(item.value)) continue;
      if (best === undefined || item.value > best.item.value) best = { item, index: i };
    }
    return best;
  }
}
