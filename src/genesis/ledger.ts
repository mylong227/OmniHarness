/**
 * 能量/成本账本（Energy ledger）。
 *
 * 守恒律（可推演的不变量）：每一笔成本必须被"记录（record）"且最终"结算（commit）"。
 * 闭合周期结束时，`pending === 0` 且 `recorded === committed` ⇒ 守恒（isConserved）。
 * 若某算子产生成本却忘记结算，isConserved 立即为假——把"未记账的耗散"变成可机械检出。
 *
 * 这是 Landauer/Toyabe（信息换能量）原理在软件层的落地：
 * 任何计算"花费"的能量都必须进入守恒账本；账本不守恒 = 系统有不可解释的能量泄漏。
 */

import { type Cost, emptyCost, concatCost } from './algebra.js';

export class Ledger {
  private pendingTokens = 0;
  private pendingJoules = 0;
  private recordedTokens = 0;
  private recordedJoules = 0;
  private committedTokens = 0;
  private committedJoules = 0;

  /** 记录一笔待结算成本（进入 pending 与 recorded 双列）。 */
  record(delta: Cost): void {
    this.pendingTokens += delta.tokens;
    this.pendingJoules += delta.joules;
    this.recordedTokens += delta.tokens;
    this.recordedJoules += delta.joules;
  }

  /** 结算当前所有 pending（pending 清零，转入 committed）。 */
  commit(): void {
    this.committedTokens += this.pendingTokens;
    this.committedJoules += this.pendingJoules;
    this.pendingTokens = 0;
    this.pendingJoules = 0;
  }

  get pending(): Cost {
    return { tokens: this.pendingTokens, joules: this.pendingJoules };
  }

  get committed(): Cost {
    return { tokens: this.committedTokens, joules: this.committedJoules };
  }

  get recorded(): Cost {
    return { tokens: this.recordedTokens, joules: this.recordedJoules };
  }

  /**
   * 守恒判定：无未结算项，且记录总额 = 结算总额。
   * 任意"记录了却未 commit"的遗漏都会令其返回 false。
   */
  isConserved(epsilon = 1e-9): boolean {
    return (
      Math.abs(this.pendingTokens) < epsilon &&
      Math.abs(this.pendingJoules) < epsilon &&
      this.recordedTokens === this.committedTokens &&
      this.recordedJoules === this.committedJoules
    );
  }
}

/** 便捷：累计合并多笔成本（复用 Cost 幺半群）。 */
export function sumCosts(costs: ReadonlyArray<Cost>): Cost {
  return costs.reduce<Cost>((acc, c) => concatCost(acc, c), emptyCost);
}
