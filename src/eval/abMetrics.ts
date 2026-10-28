/**
 * Harness A/B 的纯统计口径（2026-10-22 评测契约）。
 *
 * 为什么必须有独立口径：同一模型换 harness 常出现 2–10pp 的通过率差、token/solved 差 40×；
 * 单次跑分无法区分信号与噪声。这里只做**可复算**的汇总：
 * - `pass@k`：k 次里至少 1 次成功；
 * - `pass^k`：k 次全部成功（可靠性，τ-bench 口径）；
 * - `tokensPerSolved`：总 token / 成功次数（无成功时为 null，不臆造 0）。
 */
export interface AbRun {
  /** 任务是否成功（验收命令/文件断言通过）。 */
  readonly ok: boolean;
  /** 本 run 的 token 总量（无 usage 时为 0）。 */
  readonly tokens: number;
  /** 墙钟毫秒（含启动）。 */
  readonly wallMs: number;
  /** 步数（可选，便于定位「步数爆炸但最终成功」）。 */
  readonly steps?: number | undefined;
}

/** 单配置汇总。 */
export interface AbSummary {
  /** 运行次数。 */
  readonly runs: number;
  /** 成功次数。 */
  readonly successes: number;
  /** pass@1：单次尝试成功率（successes / runs；0 次运行时为 0）。 */
  readonly passAt1: number;
  /** pass@k：至少一次成功。 */
  readonly passAtK: boolean;
  /** pass^k：k 次全部成功。 */
  readonly passAllK: boolean;
  /** 总 token。 */
  readonly tokens: number;
  /** 总墙钟毫秒。 */
  readonly wallMs: number;
  /** 每成功一次的 token；无成功或 usage 缺失（0）为 null。 */
  readonly tokensPerSolved: number | null;
}

/** 配对比较结果。 */
export interface PairedDelta {
  /** 对齐的 run 数（两配置同 k）。 */
  readonly n: number;
  /** B 相对 A 的成功率差（正值 = B 更好）。 */
  readonly successDelta: number;
  /** B/A 的 token 总量比（A 为 0 时为 null）。 */
  readonly tokenRatio: number | null;
  /**
   * 成功率差的配对 bootstrap 95% 置信区间（2000 次重采样，固定种子 ⇒ 可复算）。
   * n < 3 时退化为 `[successDelta, successDelta]`（样本太少，不假装有区间）。
   */
  readonly successDeltaCi95: readonly [number, number];
  /**
   * 80% 区间的半宽（bootstrap 的 q90−q10 再除 2），作为「可检测效应」的近似。
   * 这是**观测数据驱动**的近似，不是正式功效分析；n 小或全同向时可能为 0。
   */
  readonly mde80: number;
}

/**
 * A/B 统计器（纯函数，无 IO）。
 */
export class AbMetrics {
  /**
   * 汇总一组 run。
   * @param runs 运行结果（同任务、同配置、k 次）。
   * @returns 汇总；空数组时全部为 false/null/0。
   */
  public static summarize(runs: readonly AbRun[]): AbSummary {
    const successes = runs.filter((run) => run.ok).length;
    const tokens = runs.reduce((sum, run) => sum + run.tokens, 0);
    const wallMs = runs.reduce((sum, run) => sum + run.wallMs, 0);
    return {
      runs: runs.length,
      successes,
      passAt1: runs.length > 0 ? successes / runs.length : 0,
      passAtK: successes > 0,
      passAllK: runs.length > 0 && successes === runs.length,
      tokens,
      wallMs,
      tokensPerSolved: successes > 0 && tokens > 0 ? tokens / successes : null,
    };
  }

  /**
   * 配对比较两组 run（按下标对齐；长度不等时只比较较短者）。
   * @param a 配置 A 的 run。
   * @param b 配置 B 的 run。
   * @returns 成功率差与 token 比。
   */
  public static paired(a: readonly AbRun[], b: readonly AbRun[]): PairedDelta {
    const n = Math.min(a.length, b.length);
    if (n === 0) {
      return {
        n: 0,
        successDelta: 0,
        tokenRatio: null,
        successDeltaCi95: [0, 0],
        mde80: 0,
      };
    }
    let aOk = 0;
    let bOk = 0;
    let aTokens = 0;
    let bTokens = 0;
    const diffs: number[] = [];
    for (let i = 0; i < n; i += 1) {
      const left = a[i] as AbRun;
      const right = b[i] as AbRun;
      if (left.ok) aOk += 1;
      if (right.ok) bOk += 1;
      aTokens += left.tokens;
      bTokens += right.tokens;
      diffs.push((right.ok ? 1 : 0) - (left.ok ? 1 : 0));
    }
    const successDelta = (bOk - aOk) / n;
    const [ciLow, ciHigh, q10, q90] = AbMetrics.bootstrap(diffs);
    return {
      n,
      successDelta,
      tokenRatio: aTokens > 0 ? bTokens / aTokens : null,
      successDeltaCi95: n < 3 ? [successDelta, successDelta] : [ciLow, ciHigh],
      mde80: n < 3 ? 1 : (q90 - q10) / 2,
    };
  }

  /**
   * 配对差的 percentile bootstrap（固定种子，确定性可复算）。
   *
   * 为什么不用正态近似：通过率是 0/1 小样本，正态区间会越界到 [0,1] 外；
   * percentile bootstrap 只需重采样均值，且能在报告里用同一段数据复跑出同一区间。
   * @param diffs 每个配对的 0/1 差值（B−A）。
   * @returns `[ci95Low, ci95High, q10, q90]`。
   */
  private static bootstrap(diffs: readonly number[]): [number, number, number, number] {
    const n = diffs.length;
    if (n === 0) return [0, 0, 0, 0];
    // LCG：固定种子 + 数据规模参与，避免 Math.random 让报告不可复算。
    let seed = (0x9e3779b9 ^ Math.imul(n, 2654435761)) >>> 0;
    const random = (): number => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 0x1_0000_0000;
    };
    const samples: number[] = [];
    const resamples = 2_000;
    for (let r = 0; r < resamples; r += 1) {
      let sum = 0;
      for (let i = 0; i < n; i += 1) {
        sum += diffs[Math.floor(random() * n)] as number;
      }
      samples.push(sum / n);
    }
    samples.sort((x, y) => x - y);
    const at = (p: number): number =>
      samples[Math.min(samples.length - 1, Math.max(0, Math.floor(p * samples.length)))] as number;
    return [at(0.025), at(0.975), at(0.1), at(0.9)];
  }
}
