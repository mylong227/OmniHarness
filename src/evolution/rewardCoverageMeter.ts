/**
 * 势函数覆盖率体检（T5.1 · RLVR 训练信号健康度）。
 *
 * 解决的问题：可验证奖励 fail-closed 把「真判负」（命令真实跑了、退出码非 0）与
 * 「不可验证」（命令缺失 / 运行器抛错 / 空测试集 → 记 0）混同为同一个 0。奖励为 0 的
 * 样本里混着多少「根本没验过」的，决定了这批训练信号的**可信密度**——势函数覆盖率。
 *
 * 产出：
 * - 覆盖率 = 真实可验证判定的样本占比（verify 过 0/1 也算覆盖，0 不是原罪，没验过才是）；
 * - `honestNote`：覆盖率不足时给出**诚实降级表述**（禁止把稀疏信号说成有效 RLVR 信号）。
 *
 * @maturity L1 — 覆盖率计量是真实统计（非启发），判定阈值是约定而非定理
 * @maturityEvidence tests/unit/rewardCoverageMeter.test.ts
 */

/** 单个样本的奖励判定明细。 */
export interface RewardVerdict {
  /** 奖励值（0..1，与既有 VerifiableReward 同口径）。 */
  readonly reward: number;
  /** 是否为「真实可验证判定」：false 表示未能验证（命令缺失/运行异常/空集），并非判负。 */
  readonly verifiable: boolean;
  /** 判定来源说明（verified-pass / verified-fail / unverifiable:<原因>）。 */
  readonly reason: string;
}

/** 带判据明细的奖励函数：调用方拿 verdict 决定计不计入覆盖。 */
export type InstrumentedReward = (candidate: unknown) => Promise<RewardVerdict>;

/** 覆盖率报告。 */
export interface RewardCoverageReport {
  /** 样本总数。 */
  readonly samples: number;
  /** 真实可验证判定数（含 verified-pass 与 verified-fail）。 */
  readonly verified: number;
  /** 不可验证数（记 0 但并未真实验证）。 */
  readonly unverifiable: number;
  /** 势函数覆盖率 = verified / samples（0..1）。 */
  readonly coverage: number;
  /** 诚实表述：覆盖率不足时的降级措辞（达标时为达标表述）。 */
  readonly honestNote: string;
}

/** 覆盖率达标线（约定值）：低于此线必须使用降级表述。 */
export const COVERAGE_THRESHOLD = 0.6;

/**
 * 把「命令退出码」奖励改造成**带判据明细**的版本（不改变原奖励语义）：
 * - 命令缺失 → { reward: 0, verifiable: false, reason: 'unverifiable:no-command' }；
 * - spawn 抛错/超时崩溃 → { reward: 0, verifiable: false, reason: 'unverifiable:spawn-error' }；
 * - 命令真实跑完 → { reward: 0|1, verifiable: true, reason: 'verified-pass' | 'verified-fail' }。
 *
 * @param commandFor 从候选抽取待验证命令
 * @param cwdFor 从候选抽取工作目录
 * @param spawn 同名注入点（默认 node:child_process.spawnSync；测试注入桩以保证确定性）
 */
export function instrumentCommandReward(
  commandFor: (candidate: unknown) => string | undefined,
  cwdFor?: (candidate: unknown) => string | undefined,
  spawn: (cmd: string, cwd: string | undefined) => { status: number | null } = () => ({
    status: -1,
  }),
): InstrumentedReward {
  return async (candidate) => {
    const cmd = commandFor(candidate);
    if (cmd === undefined)
      return { reward: 0, verifiable: false, reason: 'unverifiable:no-command' };
    try {
      const r = spawn(cmd, cwdFor?.(candidate));
      const status = r.status ?? -1;
      return status === 0
        ? { reward: 1, verifiable: true, reason: 'verified-pass' }
        : { reward: 0, verifiable: true, reason: 'verified-fail' };
    } catch (err) {
      return { reward: 0, verifiable: false, reason: `unverifiable:spawn-error:${String(err)}` };
    }
  };
}

/**
 * 覆盖率计量器：包一层 InstrumentedReward，逐样本记账，随时出体检报告。
 */
export class RewardCoverageMeter {
  /** 已记录的样本判定明细（体检数据源）。 */
  private readonly outcomes: RewardVerdict[] = [];

  /**
   * 包装带明细的奖励为普通 VerifiableReward（记录明细，只透出数值；fail-closed 同原口径）。
   * @param instrumented 带判据明细的奖励
   * @returns 与既有 VerifiableReward 兼容的数值奖励
   */
  public wrap(instrumented: InstrumentedReward): (candidate: unknown) => Promise<number> {
    return async (candidate) => {
      let verdict: RewardVerdict;
      try {
        verdict = await instrumented(candidate);
      } catch (err) {
        verdict = { reward: 0, verifiable: false, reason: `unverifiable:throw:${String(err)}` };
      }
      this.outcomes.push(verdict);
      return verdict.reward;
    };
  }

  /**
   * 出覆盖率体检报告。
   * @returns 覆盖率 + 诚实表述（未达标即降级措辞）
   */
  public report(): RewardCoverageReport {
    const samples = this.outcomes.length;
    const verified = this.outcomes.filter((o) => o.verifiable).length;
    const unverifiable = samples - verified;
    const coverage = samples === 0 ? 0 : verified / samples;
    return {
      samples,
      verified,
      unverifiable,
      coverage,
      honestNote: honestNote(coverage),
    };
  }

  /**
   * 清空记录（新一轮体检）。
   * @returns 无返回值（void）。
   */
  public reset(): void {
    this.outcomes.length = 0;
  }
}

/**
 * 诚实表述：覆盖率是否达标、不足时如何降级措辞（D7 纪律：不为达标而改口径）。
 * @param coverage 覆盖率（0..1）
 * @returns 人类可读的诚实结论
 */
export function honestNote(coverage: number): string {
  if (coverage >= COVERAGE_THRESHOLD) {
    return `势函数覆盖率 ${(coverage * 100).toFixed(1)}%（≥${COVERAGE_THRESHOLD * 100}%），RLVR 信号密度可用。`;
  }
  return `势函数覆盖率仅 ${(coverage * 100).toFixed(1)}%（<${COVERAGE_THRESHOLD * 100}%）：信号稀疏，不得声称有效 RLVR 训练信号，进化按 fail-closed 保守处理。`;
}
