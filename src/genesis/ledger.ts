/**
 * 成本账本（Cost ledger）——**记账不变量**，不是物理守恒律。
 *
 * 不变量（可推演、可机械检出）：每一笔成本必须被"记录（record）"且最终"结算（commit）"。
 * 闭合周期结束时，`pending === 0` 且 `recorded === committed` ⇒ 账本闭合（isConserved）。
 * 若某算子产生成本却忘记结算，isConserved 立即为假——把"未记账的耗散"变成可机械检出。
 *
 * 措辞边界（2026-09-12，见 docs/library/20-physics.md §9）：
 * 这是**会计恒等式**——一个可被违反、且违反即被检出的断言，**不是**热力学第一定律。
 * 故不得引用 Landauer/Toyabe 原理为它背书：本账本不度量物理能量，也不承诺 joules 为实测值；
 * 字段名 `joules` 是由经验系数估算的**代理值**，非实测物理量。
 *
 * @maturity L3 — record/commit 闭合可机械检出；记账不变量，非物理守恒
 * @maturityEvidence tests/unit/genesis.test.ts
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
  public record(delta: Cost): void {
    this.pendingTokens += delta.tokens;
    this.pendingJoules += delta.joules;
    this.recordedTokens += delta.tokens;
    this.recordedJoules += delta.joules;
  }

  /** 结算当前所有 pending（pending 清零，转入 committed）。 */
  public commit(): void {
    this.committedTokens += this.pendingTokens;
    this.committedJoules += this.pendingJoules;
    this.pendingTokens = 0;
    this.pendingJoules = 0;
  }

  public get pending(): Cost {
    return { tokens: this.pendingTokens, joules: this.pendingJoules };
  }

  public get committed(): Cost {
    return { tokens: this.committedTokens, joules: this.committedJoules };
  }

  public get recorded(): Cost {
    return { tokens: this.recordedTokens, joules: this.recordedJoules };
  }

  /**
   * 守恒判定：无未结算项，且记录总额 = 结算总额。
   * 任意"记录了却未 commit"的遗漏都会令其返回 false。
   */
  public isConserved(epsilon = 1e-9): boolean {
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
