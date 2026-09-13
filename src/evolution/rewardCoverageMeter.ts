/**
 * 势函数覆盖率体检（T5.1 · RLVR 训练信号健康度）。
 *
 * 解决的问题：可验证奖励 fail-closed 把「真判负」（命令真实跑了、退出码非 0）与
 * 「不可验证」（命令缺失 / 运行器抛错 / 空测试集 → 记 0）混同为同一个 0。奖励为 0 的
 * 样本里混着多少「根本没验过」的，决定了这批训练信号的**可信密度**——势函数覆盖率。
 *
 * 产出：
 * - 覆盖率 = 真实可验证判定的样本占比（verify 过 0/1 也算覆盖，0 不是原罪，没验过才是）；
 * - 报告附**诚实降级表述**（禁止把稀疏信号说成有效 RLVR 信号）。
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

/** 覆盖率达标线（约定值）：低于此线必须使用降级表述。 */
export const COVERAGE_THRESHOLD = 0.6;

/**
 * 覆盖率计量器：包装带明细的奖励探针，逐样本记账，随时出体检报告。
 */
export class RewardCoverageMeter {
  /** 已记录的样本判定明细（体检数据源）。 */
  private readonly outcomes: RewardVerdict[] = [];

  /**
   * 包装探针为普通数值奖励（记录明细，只透出数值；fail-closed 同原口径）。
   * @param probe 带判据明细的命令探针（或任何 InstrumentedReward 形状的对象）
   * @returns 与既有 VerifiableReward 兼容的数值奖励
   */
  public wrap(probe: {
    verify(candidate: unknown): Promise<RewardVerdict>;
  }): (candidate: unknown) => Promise<number> {
    return async (candidate) => {
      let verdict: RewardVerdict;
      try {
        verdict = await probe.verify(candidate);
      } catch (err) {
        verdict = { reward: 0, verifiable: false, reason: `unverifiable:throw:${String(err)}` };
      }
      this.outcomes.push(verdict);
      return verdict.reward;
    };
  }

  /**
   * 出覆盖率体检报告。
   * @returns 覆盖率报告值对象（含诚实表述 getter）
   */
  public report(): RewardCoverageReport {
    const verified = this.outcomes.filter((o) => o.verifiable).length;
    return new RewardCoverageReport(this.outcomes.length, verified);
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
 * 命令探针：把「命令退出码」奖励改造成**带判据明细**的版本（不改变原奖励语义）。
 * - 命令缺失 → { reward: 0, verifiable: false, reason: 'unverifiable:no-command' }；
 * - spawn 抛错/超时崩溃 → { reward: 0, verifiable: false, reason: 'unverifiable:spawn-error' }；
 * - 命令真实跑完 → { reward: 0|1, verifiable: true, reason: 'verified-pass' | 'verified-fail' }。
 */
export class CommandRewardProbe {
  /** 候选 → 待验证命令抽取器。 */
  private readonly commandFor: (candidate: unknown) => string | undefined;
  /** 候选 → 工作目录抽取器（可选）。 */
  private readonly cwdFor: ((candidate: unknown) => string | undefined) | undefined;
  /** 命令执行注入点（返回退出码；测试注入桩保证确定性）。 */
  private readonly spawn: (cmd: string, cwd: string | undefined) => { status: number | null };

  /**
   * @param commandFor 从候选抽取待验证命令
   * @param cwdFor 从候选抽取工作目录（可选）
   * @param spawn 执行注入点（默认 sync 退出码 -1；测试注入桩保证确定性）
   */
  public constructor(
    commandFor: (candidate: unknown) => string | undefined,
    cwdFor?: (candidate: unknown) => string | undefined,
    spawn: (cmd: string, cwd: string | undefined) => { status: number | null } = () => ({
      status: -1,
    }),
  ) {
    this.commandFor = commandFor;
    this.cwdFor = cwdFor;
    this.spawn = spawn;
  }

  /**
   * 验证单个候选并给出判据明细。
   * @param candidate 候选（透传给 commandFor/cwdFor）
   * @returns 判据明细（reward + verifiable + reason）
   */
  public async verify(candidate: unknown): Promise<RewardVerdict> {
    const cmd = this.commandFor(candidate);
    if (cmd === undefined)
      return { reward: 0, verifiable: false, reason: 'unverifiable:no-command' };
    try {
      const r = this.spawn(cmd, this.cwdFor?.(candidate));
      const status = r.status ?? -1;
      return status === 0
        ? { reward: 1, verifiable: true, reason: 'verified-pass' }
        : { reward: 0, verifiable: true, reason: 'verified-fail' };
    } catch (err) {
      return { reward: 0, verifiable: false, reason: `unverifiable:spawn-error:${String(err)}` };
    }
  }
}

/**
 * 覆盖率报告值对象：字段 + 诚实表述（D9：报告为 class，honestNote 是派生 getter）。
 */
export class RewardCoverageReport {
  /** 样本总数。 */
  public readonly samples: number;
  /** 真实可验证判定数（含 verified-pass 与 verified-fail）。 */
  public readonly verified: number;
  /** 不可验证数（记 0 但并未真实验证）。 */
  public readonly unverifiable: number;
  /** 势函数覆盖率 = verified / samples（0..1）。 */
  public readonly coverage: number;

  /**
   * @param samples 样本总数
   * @param verified 可验证判定数
   */
  public constructor(samples: number, verified: number) {
    this.samples = samples;
    this.verified = verified;
    this.unverifiable = samples - verified;
    this.coverage = samples === 0 ? 0 : verified / samples;
  }

  /** 诚实表述 getter：覆盖率不足时给降级措辞（D7 纪律：不为达标而改口径）。 */
  public get honestNote(): string {
    const pct = (this.coverage * 100).toFixed(1);
    const line = (COVERAGE_THRESHOLD * 100).toFixed(0);
    if (this.coverage >= COVERAGE_THRESHOLD) {
      return `势函数覆盖率 ${pct}%（≥${line}%），RLVR 信号密度可用。`;
    }
    return `势函数覆盖率仅 ${pct}%（<${line}%）：信号稀疏，不得声称有效 RLVR 训练信号，进化按 fail-closed 保守处理。`;
  }
}
