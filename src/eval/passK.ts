/**
 * Pass@k 统计门禁（U5 专属 eval 门禁规模化核心）。
 *
 * 提供无偏 Pass@k 估计：给定 N 个任务，每任务 m 次独立采样的通过布尔，
 * 返回 k∈[1..maxK] 的 Pass@k（标准 unbiased estimator）。并配套 fail-closed
 * 门禁：通过率 / Pass@k 低于阈值即视为不达标（exit 非 0 由调用方处理）。
 *
 * 零依赖。
 */

/** 单任务的多次采样结果（布尔：本次采样是否通过）。 */
export type TaskSamples = readonly boolean[];

/** Pass@k 汇总。 */
export interface PassKSummary {
  /** 任务数。 */
  readonly tasks: number;
  /** 每任务平均通过率（= 通过采样数 / 总采样数）。 */
  readonly meanPassRate: number;
  /** k 对应的 Pass@k（索引 0 = Pass@1）。 */
  readonly passAtK: readonly number[];
  /** 总采样次数（所有任务之和）。 */
  readonly totalSamples: number;
}

/** 组合数 C(n, k)（浮点，n/k 较小时精确）。n<k 或 k<0 返回 0。 */
export function combination(n: number, k: number): number {
  if (k < 0 || k > n) return 0;
  if (k === 0 || k === n) return 1;
  // 取较小分支避免溢出。
  k = Math.min(k, n - k);
  let result = 1;
  for (let i = 0; i < k; i++) {
    result = (result * (n - i)) / (i + 1);
  }
  return result;
}

/**
 * 无偏 Pass@k 估计。
 * 对每个任务：Pass@k = 1 − C(n−c, k) / C(n, k)；若 k>n 则为 1（样本全错也不该被惩罚）。
 * 跨任务取平均。
 */
export function computePassK(outcomes: readonly TaskSamples[], maxK: number): number[] {
  const result: number[] = [];
  if (outcomes.length === 0) return new Array<number>(maxK).fill(0);
  for (let k = 1; k <= maxK; k++) {
    let sum = 0;
    for (const runs of outcomes) {
      const n = runs.length;
      if (n === 0) continue;
      const c = runs.filter(Boolean).length;
      if (k > n) {
        sum += 1;
        continue;
      }
      const denom = combination(n, k);
      const num = combination(n - c, k);
      sum += 1 - num / denom;
    }
    result.push(sum / outcomes.length);
  }
  return result;
}

/** 每任务平均通过率（与采样次数加权）。 */
export function meanPassRate(outcomes: readonly TaskSamples[]): number {
  let total = 0;
  let samples = 0;
  for (const runs of outcomes) {
    samples += runs.length;
    total += runs.filter(Boolean).length;
  }
  return samples === 0 ? 0 : total / samples;
}

/** 汇总：meanPassRate + passAtK[1..maxK]。 */
export function summarizePassK(outcomes: readonly TaskSamples[], maxK: number): PassKSummary {
  const passAtK = computePassK(outcomes, maxK);
  return {
    tasks: outcomes.length,
    meanPassRate: meanPassRate(outcomes),
    passAtK,
    totalSamples: outcomes.reduce((s, r) => s + r.length, 0),
  };
}

/**
 * fail-closed 门禁判定：给定汇总与阈值，达标返回 true。
 * 任一指标低于阈值即不达标（fail-closed）。
 */
export function passKGate(
  summary: PassKSummary,
  opts: {
    readonly minPassRate?: number;
    readonly minPassK?: readonly { readonly k: number; readonly threshold: number }[];
  },
): { readonly passed: boolean; readonly failures: readonly string[] } {
  const failures: string[] = [];
  const minPassRate = opts.minPassRate ?? 0;
  if (summary.meanPassRate < minPassRate) {
    failures.push(`通过率 ${summary.meanPassRate.toFixed(3)} < 阈值 ${minPassRate}`);
  }
  for (const req of opts.minPassK ?? []) {
    const idx = req.k - 1;
    const actual = summary.passAtK[idx];
    if (actual === undefined) continue;
    if (actual < req.threshold) {
      failures.push(`Pass@${req.k} ${actual.toFixed(3)} < 阈值 ${req.threshold}`);
    }
  }
  return { passed: failures.length === 0, failures };
}
