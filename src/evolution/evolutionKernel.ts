/**
 * 进化内核（GEE Kernel v1 · 编排核心，ADR-0008 / EVOLUTION_ARCH_UPGRADE_2026-10）。
 *
 * 把进化闭环从「组合根里的散件拼装」升格为一等公民域的唯一编排器，串起七环：
 *
 *   ① ingest   信号采集：`EvolutionSignalSourcePort` 收 production 失败/成功信号——
 *              失败进失败模式挖掘器（防再犯提案），成功组合进相变固化器（密度抬升）；
 *   ② expand   档案扩展：候选按工况桶入 {@link BucketedCandidateArchive}（精英保留），
 *              负结果冻结不删除，同工况复现复活并经 {@link EliteReentryDiscovery} 重入候选流；
 *   ③ verify   内层控制器（门禁 + RLVR 可验证奖励）真实评估；
 *   ④ gate     内层准入（多样性闸 + 退火接受 + 覆盖率闸）——语义全部留在内层不旁路；
 *   ⑤ snapshot 晋升前快照（S3 起接 `PromotionLedgerPort`：无快照不晋升）；
 *   ⑥ promote  晋升（组合根注入的 `onPromote`，通常 = `registry.replace`）；
 *   ⑦ observe  `evolution.kernel.*` 观测行 + 体检报告。
 *
 * 关键边界：
 * - **实现既有 `EvolutionController` 端口**——`core/agent.ts` 触发点与 `OmniHarnessRuntime`
 *   契约零改动；关掉（`evolutionRlvr.kernel` 缺省 false）即回现状路径。
 * - **晋升裁决权在内层**：本类绝不把未通过门禁/准入的候选改成晋升（只做减法之外的
 *   事情一律不做）——本类只对内层已放行的裁决补齐「快照 → 晋升 → 档案退役」的治理尾巴。
 * - **fail-closed**：任何一环异常只告警（`evolution.kernel.cycle.failed`），绝不连累主任务。
 * - 复活复核带**复核次数上限**（默认 3）：反复复核仍被拒者退役停复活，防「拒绝 ⇄ 复活」
 *   永动空转（复核成本是评估预算的一部分）。
 *
 * @maturity L1 — 七环编排接线真实（判据钉死）；增益未经两关统计，默认关
 * @maturityEvidence tests/unit/evolutionKernel.test.ts
 */
import type {
  Candidate,
  EvolutionController,
  EvolutionSignal,
  EvolutionSignalSourcePort,
  CandidateArchivePort,
  PromotionVerdict,
} from '../ports/runtime/evolution.js';
import type { CapabilityCrystallizerPort } from '../ports/intelligence/capability.js';
import { FailurePatternMiner } from './failurePatternMiner.js';
import type { FailureRecord } from './failurePatternMiner.js';
import type { EliteReentryDiscovery } from './eliteReentryDiscovery.js';
import { log } from '../util/logger.js';

/** 一轮 Kernel 体检报告（ring ⑦ 观测面）。 */
export interface EvolutionKernelReport {
  /** 本轮采集的信号数。 */
  readonly signals: number;
  /** 本轮路由进失败挖掘器的失败信号数。 */
  readonly failures: number;
  /** 本轮喂给固化器的成功组合观测数。 */
  readonly successObservations: number;
  /** 失败模式挖掘产出的改进提案摘要（跨轮累积失败历史聚类，频次降序）。 */
  readonly proposals: readonly string[];
  /** 本轮评估的候选数。 */
  readonly evaluated: number;
  /** 本轮晋升数（已过内层全部门禁且完成晋升回调）。 */
  readonly promoted: number;
  /** 本轮入档候选数。 */
  readonly archived: number;
  /** 本轮复活并排入下轮重入流的候选数（复核次数超限者不计入）。 */
  readonly revived: number;
  /** 重入队列当前长度（待复核者）。 */
  readonly reentryPending: number;
  /** 降级口径（如信号源缺失 / 档案缺失——装配缺件时如实申报，不静默）。 */
  readonly degraded: readonly string[];
}

/** 进化内核选项。 */
export interface EvolutionKernelOptions {
  /** 内层控制器（发现 → 门禁 → RLVR → 准入 → 覆盖率闸；即既有 `RlvrEvolutionController`）。 */
  readonly inner: EvolutionController;
  /** 信号源端口（ring ①；缺省 = 无信号，退化申报进 `degraded`）。 */
  readonly signals?: EvolutionSignalSourcePort | undefined;
  /** 候选档案端口（ring ②；缺省 = 不入档，退化申报进 `degraded`）。 */
  readonly archive?: CandidateArchivePort | undefined;
  /** 精英重入发现引擎（ring ② 的候选流注入面；缺省 = 无重入通道）。 */
  readonly reentry?: EliteReentryDiscovery | undefined;
  /** 相变固化器端口（成功组合密度去向；缺省 = 只统计不观测）。 */
  readonly crystallizer?: CapabilityCrystallizerPort | undefined;
  /** 真实晋升回调（ring ⑥；组合根注入，通常 = registry.replace + 观测行）。 */
  readonly onPromote?: ((candidate: Candidate) => void) | undefined;
  /** 工况桶键派生（ring ②；缺省 = 候选来源算子前缀，如 `twist:a+b` → `twist`）。 */
  readonly bucketFor?: ((candidate: Candidate) => string) | undefined;
  /** 失败提案升格阈值（默认 3，透传内核自持的失败模式挖掘器）。 */
  readonly failureThreshold?: number | undefined;
  /** 同一候选复活复核次数上限（默认 3；超限退役停复活，防拒绝⇄复活空转）。 */
  readonly maxRecheckAttempts?: number | undefined;
  /** 失败记录累积上限（默认 512；超出淘汰最旧者，有界缓冲）。 */
  readonly maxFailureRecords?: number | undefined;
}

/** 信号路由结果（体检数据源）。 */
interface IngestOutcome {
  readonly failures: number;
  readonly successes: number;
}

/** 档案更新结果（体检数据源）。 */
interface ArchiveOutcome {
  readonly archived: number;
  readonly revived: number;
}

/** 复核次数超限后的冻结 reason 前缀（退役申报，观测可辨）。 */
const RETIRE_AFTER_RECHECKS = 'rejected:rechecks-exhausted';

/** 进化内核：七环编排器（实现既有 EvolutionController 端口）。 */
export class EvolutionKernel implements EvolutionController {
  /** 任务末自动进化标志（透传内层，真实控制 Agent 是否跑本轮）。 */
  public readonly autoRun: boolean;
  /** 内层控制器（ring ③④⑤ 的裁决权所在）。 */
  private readonly inner: EvolutionController;
  /** 信号源端口。 */
  private readonly signals?: EvolutionSignalSourcePort | undefined;
  /** 候选档案端口。 */
  private readonly archive?: CandidateArchivePort | undefined;
  /** 精英重入发现引擎。 */
  private readonly reentry?: EliteReentryDiscovery | undefined;
  /** 相变固化器端口。 */
  private readonly crystallizer?: CapabilityCrystallizerPort | undefined;
  /** 真实晋升回调。 */
  private readonly onPromote?: ((candidate: Candidate) => void) | undefined;
  /** 工况桶键派生。 */
  private readonly bucketFor: (candidate: Candidate) => string;
  /** 内核自持的失败模式挖掘器（生产失败信号的防再犯提案来源）。 */
  private readonly miner: FailurePatternMiner;
  /** 复核次数上限。 */
  private readonly maxRecheckAttempts: number;
  /** 失败记录累积上限。 */
  private readonly maxFailureRecords: number;
  /** 跨轮累积的失败记录（挖掘器输入；有界）。 */
  private readonly failureRecords: FailureRecord[] = [];
  /** 候选名 → 已复核次数（复活重入后仍被拒即 +1；超限退役）。 */
  private readonly rechecks = new Map<string, number>();
  /** 最近一轮体检报告。 */
  private lastReport: EvolutionKernelReport | undefined;

  /**
   * @param opts 内层控制器与各环端口（信号源 / 档案 / 重入 / 固化器可缺省，缺件进降级申报）
   */
  public constructor(opts: EvolutionKernelOptions) {
    this.inner = opts.inner;
    this.autoRun = opts.inner.autoRun;
    this.signals = opts.signals;
    this.archive = opts.archive;
    this.reentry = opts.reentry;
    this.crystallizer = opts.crystallizer;
    this.onPromote = opts.onPromote;
    this.bucketFor = opts.bucketFor ?? EvolutionKernel.defaultBucketFor;
    this.miner = new FailurePatternMiner(opts.failureThreshold ?? 3);
    this.maxRecheckAttempts = Math.max(0, Math.floor(opts.maxRecheckAttempts ?? 3));
    this.maxFailureRecords = Math.max(1, Math.floor(opts.maxFailureRecords ?? 512));
  }

  /**
   * 评估单个候选（转发内层门禁；准入只在 `cycle()` 批量路径上）。
   * @param candidate 待评估候选
   * @returns 门禁裁决
   */
  public evaluate(candidate: Candidate): Promise<PromotionVerdict> {
    return this.inner.evaluate(candidate);
  }

  /**
   * 当前预算消耗（转发内层发现引擎）。
   * @returns 已生成候选数与上限
   */
  public budgetUsed(): { readonly generated: number; readonly maxCandidates: number } {
    return this.inner.budgetUsed();
  }

  /**
   * 最近一轮体检报告（未跑过为 undefined）。
   * @returns 体检报告或 undefined
   */
  public report(): EvolutionKernelReport | undefined {
    return this.lastReport;
  }

  /**
   * 跑一轮七环闭环：①信号 → ②档案/重入 → ③④内层评估 → ⑤⑥晋升 → 档案退役/复活 → ⑦观测。
   * 任何异常只告警并返回空裁决流（fail-closed，绝不连累主任务）。
   * @returns 内层裁决流（原样透传；本类不改写晋升语义）
   */
  public async cycle(): Promise<readonly PromotionVerdict[]> {
    try {
      const signals = this.signals !== undefined ? this.signals.collect() : [];
      const ingested = this.ingest(signals);
      const reentryPending = this.reentry !== undefined ? this.reentry.pending() : 0;
      const verdicts = await this.inner.cycle();
      const promoted = this.applyPromotion(verdicts);
      const archived = this.updateArchive(verdicts);
      const report = this.summarize(
        signals.length,
        ingested,
        reentryPending,
        verdicts,
        promoted,
        archived,
      );
      this.lastReport = report;
      this.emit(report);
      return verdicts;
    } catch (err) {
      log.warn('evolution.kernel.cycle.failed', { error: String(err) });
      return [];
    }
  }

  /**
   * 默认工况桶键：候选来源的算子前缀（`twist:a+b` → `twist`；无前缀取全串）。
   * @param candidate 候选
   * @returns 工况桶键
   */
  private static defaultBucketFor(candidate: Candidate): string {
    const sep = candidate.source.indexOf(':');
    return sep > 0 ? candidate.source.slice(0, sep) : candidate.source;
  }

  /**
   * ring ① ingest：失败信号进挖掘器（有界累积），成功组合喂固化器（密度抬升）。
   * @param signals 本轮采集的信号流
   * @returns 路由计数
   */
  private ingest(signals: readonly EvolutionSignal[]): IngestOutcome {
    let failures = 0;
    let successes = 0;
    for (const signal of signals) {
      if (signal.kind === 'failure' && signal.failure !== undefined) {
        this.failureRecords.push(signal.failure);
        failures++;
        continue;
      }
      if (signal.kind === 'success' && signal.success !== undefined) {
        this.crystallizer?.observe(signal.success.combination);
        successes++;
      }
    }
    if (this.failureRecords.length > this.maxFailureRecords) {
      this.failureRecords.splice(0, this.failureRecords.length - this.maxFailureRecords);
    }
    return { failures, successes };
  }

  /**
   * ring ⑤⑥ 晋升：对内层已放行的裁决逐个执行晋升回调（单点失败只告警，不连累其余晋升）。
   * （S3 起在此前插 `PromotionLedgerPort.snapshotBefore`——无快照不晋升。）
   * @param verdicts 内层裁决流
   * @returns 实际完成晋升回调的候选数
   */
  private applyPromotion(verdicts: readonly PromotionVerdict[]): number {
    let promoted = 0;
    for (const verdict of verdicts) {
      if (!verdict.promoted) continue;
      try {
        this.onPromote?.(verdict.candidate);
        promoted++;
      } catch (err) {
        log.warn('evolution.kernel.promote.failed', {
          skill: verdict.candidate.skill.name,
          error: String(err),
        });
      }
    }
    return promoted;
  }

  /**
   * ring ② 档案更新：候选按工况入档（精英保留）→ 本轮活跃桶的**早前轮次**冻结者复活 →
   * 最后冻结本轮裁决（晋升者退役 / 被拒者暂停）。
   *
   * 顺序不可换：复活必须发生在本轮冻结**之前**，否则「同轮冻结者被同轮复活」——
   * 复活的语义是「同工况桶再次有新候选时，给早前的负结果第二次机会」，不是无间隔重采样。
   * @param verdicts 内层裁决流
   * @returns 档案更新计数
   */
  private updateArchive(verdicts: readonly PromotionVerdict[]): ArchiveOutcome {
    if (this.archive === undefined) return { archived: 0, revived: 0 };
    const active = new Set<string>();
    for (const verdict of verdicts) {
      const bucket = this.bucketFor(verdict.candidate);
      this.archive.put(verdict.candidate, bucket, verdict.score);
      active.add(bucket);
    }
    let revived = 0;
    const requeue: Candidate[] = [];
    for (const bucket of active) {
      for (const entry of this.archive.reviveFor(bucket)) {
        const name = entry.candidate.skill.name;
        const attempts = this.rechecks.get(name) ?? 0;
        if (attempts >= this.maxRecheckAttempts) {
          // 复核超限：留档停复活（如实申报 reason；档案状态归位为冻结，不进重入流）。
          this.archive.freeze(name, RETIRE_AFTER_RECHECKS);
          continue;
        }
        this.rechecks.set(name, attempts + 1);
        requeue.push(entry.candidate);
        revived++;
      }
    }
    for (const verdict of verdicts) {
      this.archive.freeze(
        verdict.candidate.skill.name,
        verdict.promoted ? 'promoted' : `rejected:${verdict.score.toFixed(3)}`,
      );
    }
    this.reentry?.enqueue(requeue);
    return { archived: verdicts.length, revived };
  }

  /**
   * 汇总本轮体检报告（缺件降级如实申报）。
   * @param signalCount 信号数
   * @param ingested 信号路由计数
   * @param reentryPending 重入队列长度（评估前）
   * @param verdicts 裁决流
   * @param promoted 晋升数
   * @param archived 档案更新计数
   * @returns 体检报告
   */
  private summarize(
    signalCount: number,
    ingested: IngestOutcome,
    reentryPending: number,
    verdicts: readonly PromotionVerdict[],
    promoted: number,
    archived: ArchiveOutcome,
  ): EvolutionKernelReport {
    const degraded: string[] = [];
    if (this.signals === undefined) degraded.push('signal-source:missing');
    if (this.archive === undefined) degraded.push('candidate-archive:missing');
    if (this.reentry === undefined) degraded.push('elite-reentry:missing');
    const proposals = this.miner.mine(this.failureRecords).proposals;
    return {
      signals: signalCount,
      failures: ingested.failures,
      successObservations: ingested.successes,
      proposals: proposals.map((p) => p.summary),
      evaluated: verdicts.length,
      promoted,
      archived: archived.archived,
      revived: archived.revived,
      reentryPending,
      degraded,
    };
  }

  /**
   * 输出本轮观测行（观测是尽力而为：任何异常都不连累进化结果）。
   * @param report 体检报告
   * @returns 无返回值（void）
   */
  private emit(report: EvolutionKernelReport): void {
    try {
      log.info('evolution.kernel.cycle', { ...report });
      if (report.degraded.length > 0) {
        log.warn('evolution.kernel.degraded', { degraded: report.degraded });
      }
    } catch {
      // 观测失败不影响进化结果（fail-closed 旁路）
    }
  }
}
