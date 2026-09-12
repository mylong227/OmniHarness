import { bootstrapInterval, type BootstrapOptions, type BootstrapResult } from './bootstrap.js';

/**
 * Pass@k 统计门禁（U5 专属 eval 门禁规模化核心）。
 *
 * 提供无偏 Pass@k 估计：给定 N 个任务，每任务 m 次独立采样的通过布尔，
 * 返回 k∈[1..maxK] 的 Pass@k（标准 unbiased estimator）。并配套 fail-closed
 * 门禁：通过率 / Pass@k 低于阈值即视为不达标（exit 非 0 由调用方处理）。
 *
 * T4.7 起为 Pass@k 提供**确定性 bootstrap 95% 置信区间**，并把判定从「点阈值」
 * 升级为「区间判定」——点阈值在边界会随机红/绿，区间判定给出三态结论
 * （达标 / 显著不达标 / 样本不足），种子固定故同输入恒同结论。
 *
 * 零依赖。
 *
 * @maturity L1 — Pass@k + 确定性 bootstrap 95% CI（消随机红/绿）；「≥5 次跑」规范化待补
 * @maturityEvidence tests/unit/passK.test.ts
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

/** Pass@k 的点估计 + 逐 k 的 bootstrap 置信区间（T4.7）。 */
export interface PassKCIReport {
  /** 点估计汇总（与 {@link summarizePassK} 一致）。 */
  readonly summary: PassKSummary;
  /** 每个 k 的 95% 区间（索引 0 = Pass@1）。 */
  readonly passAtKCI: readonly BootstrapResult[];
  /** 平均通过率的 95% 区间。 */
  readonly meanPassRateCI: BootstrapResult;
}

/**
 * 对每个任务的采样做有放回重采样，给出 Pass@k 与平均通过率的 95% 置信区间。
 *
 * 复用 {@link bootstrapInterval}（同一方法、默认 2000 次）；**种子固定** ⇒ 同一
 * 输入恒得同一区间与结论，消除「点阈值随机红/绿」。
 *
 * @param outcomes 每任务的多次采样结果
 * @param maxK 最大 k（区间覆盖 Pass@1..Pass@maxK）
 * @param opts 次数 / 种子 / 显著性（可选）
 * @returns 点估计 + 逐 k 区间 + 平均通过率区间
 */
export function bootstrapPassK(
  outcomes: readonly TaskSamples[],
  maxK: number,
  opts: BootstrapOptions = {},
): PassKCIReport {
  const summary = summarizePassK(outcomes, maxK);
  const passAtKCI: BootstrapResult[] = [];
  for (let k = 1; k <= maxK; k++) {
    passAtKCI.push(bootstrapInterval(outcomes, (rs) => computePassK(rs, k)[k - 1] ?? 0, opts));
  }
  const meanPassRateCI = bootstrapInterval(outcomes, (rs) => meanPassRate(rs), opts);
  return { summary, passAtKCI, meanPassRateCI };
}

/** 区间门禁结论：达标 / 显著不达标 / 样本不足（fail-closed）。 */
export interface PassKCIGateResult {
  /** 是否达标（无 failure 且无 inconclusive）。 */
  readonly passed: boolean;
  /** 显著低于阈值项（区间上界 < 阈值）。 */
  readonly failures: readonly string[];
  /** 样本不足项（区间跨阈值，无法判定；fail-closed 计入不达标）。 */
  readonly inconclusive: readonly string[];
}

/**
 * 区间版 fail-closed 门禁（T4.7）：
 * - 区间下界 ≥ 阈值 ⇒ 达标（可信）；
 * - 区间上界 < 阈值 ⇒ 显著不达标；
 * - 区间跨阈值 ⇒ 样本不足，inconclusive（fail-closed：仍判不达标，但显式区分）。
 *
 * 因区间由固定种子 bootstrap 得到，同一结果下**重复判定恒同**，不再随机红/绿。
 *
 * @param report {@link bootstrapPassK} 的产出
 * @param opts 阈值（通过率 / 逐 k）
 * @returns 三态结论
 */
export function passKGateWithCI(
  report: PassKCIReport,
  opts: {
    readonly minPassRate?: number;
    readonly minPassK?: readonly { readonly k: number; readonly threshold: number }[];
  },
): PassKCIGateResult {
  const failures: string[] = [];
  const inconclusive: string[] = [];
  const judge = (label: string, threshold: number, ci: BootstrapResult): void => {
    if (ci.lo >= threshold) return;
    if (ci.hi < threshold) {
      failures.push(`${label} 区间上界 ${ci.hi.toFixed(3)} < 阈值 ${threshold}`);
    } else {
      inconclusive.push(
        `${label} 区间 [${ci.lo.toFixed(3)}, ${ci.hi.toFixed(3)}] 跨阈值 ${threshold}，样本不足`,
      );
    }
  };
  judge('通过率', opts.minPassRate ?? 0, report.meanPassRateCI);
  for (const req of opts.minPassK ?? []) {
    const ci = report.passAtKCI[req.k - 1];
    if (ci === undefined) continue;
    judge(`Pass@${req.k}`, req.threshold, ci);
  }
  return { passed: failures.length === 0 && inconclusive.length === 0, failures, inconclusive };
}
