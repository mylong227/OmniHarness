/**
 * 信念数学工具（零依赖）：对角高斯 KL 分解 + 重参数化不变性审计。
 * 供 `naturalGradient.ts` 与 `particleFilter.ts` 复用，避免公式在两处发散。
 */

import type { BeliefKlComponent } from '../ports/intelligence/metacognition.js';

/**
 * BeliefMath —— 由本文件原顶层函数归并而来（每个方法对应一个原函数，语义与签名逐字保留）。
 */
export class BeliefMath {
  /**
   * 两对角高斯 N(μ_a, σ_a²) 与 N(μ_b, σ_b²) 的 KL(a‖b) 分解为可命名分量（逐维求和）：
   * - meanShift_i = ½ (μ_a−μ_b)² / σ_b²
   * - variance_i  = ½ [ σ_a²/σ_b² − 1 + ln(σ_b²/σ_a²) ]
   * 维数不一致时以较短者为准（缺维视为 0）。fail-closed：方差夹地板避免除零/ln(0)。
   */
  public static klDiagonal(
    meanAfter: readonly number[],
    varAfter: readonly number[],
    meanBefore: readonly number[],
    varBefore: readonly number[],
    varianceFloor = 1e-9,
  ): KlDecomposition {
    const n = Math.min(meanAfter.length, meanBefore.length);
    const perDim: BeliefKlComponent[] = [];
    let meanShift = 0;
    let variance = 0;
    for (let i = 0; i < n; i++) {
      const sb = Math.max(varBefore[i] ?? 0, varianceFloor);
      const sa = Math.max(varAfter[i] ?? 0, varianceFloor);
      const dMu = (meanAfter[i] ?? 0) - (meanBefore[i] ?? 0);
      const ms = (0.5 * (dMu * dMu)) / sb;
      const va = 0.5 * (sa / sb - 1 + Math.log(sb / sa));
      meanShift += ms;
      variance += va;
      perDim.push({ dim: i, meanShift: ms, variance: va, total: ms + va });
    }
    return { total: meanShift + variance, meanShift, variance, perDimension: perDim };
  }

  /**
   * 重参数化不变性审计：把维度排列（逆序）后重算总 KL，应与原总 KL 一致（坐标图无关，误差 < 1e-9）。
   * KL 是流形上的标量，不依赖维度排序这一坐标表示。
   */
  public static reparamInvariant(
    meanAfter: readonly number[],
    varAfter: readonly number[],
    meanBefore: readonly number[],
    varBefore: readonly number[],
  ): boolean {
    const orig = BeliefMath.klDiagonal(meanAfter, varAfter, meanBefore, varBefore).total;
    const perm = (a: readonly number[]) => (a.length === 0 ? a : a.slice().reverse());
    const flipped = BeliefMath.klDiagonal(
      perm(meanAfter),
      perm(varAfter),
      perm(meanBefore),
      perm(varBefore),
    ).total;
    return Math.abs(flipped - orig) < 1e-9;
  }
}

export interface KlDecomposition {
  readonly total: number;
  readonly meanShift: number;
  readonly variance: number;
  readonly perDimension: ReadonlyArray<BeliefKlComponent>;
}
