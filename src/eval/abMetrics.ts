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
      return { n: 0, successDelta: 0, tokenRatio: null };
    }
    let aOk = 0;
    let bOk = 0;
    let aTokens = 0;
    let bTokens = 0;
    for (let i = 0; i < n; i += 1) {
      const left = a[i] as AbRun;
      const right = b[i] as AbRun;
      if (left.ok) aOk += 1;
      if (right.ok) bOk += 1;
      aTokens += left.tokens;
      bTokens += right.tokens;
    }
    return {
      n,
      successDelta: (bOk - aOk) / n,
      tokenRatio: aTokens > 0 ? bTokens / aTokens : null,
    };
  }
}
