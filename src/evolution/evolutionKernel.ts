/**
 * 进化内核（GEE Kernel v1 · 编排核心，ADR-0008 / EVOLUTION_ARCH_UPGRADE_2026-10）。
 *
 * 把进化闭环从「组合根里的散件拼装」升格为一等公民域的唯一编排器，串起七环：
 *
 *   ① ingest   信号采集：{@link SignalIngestor} 把 production 失败/成功信号分别路由进
 *              失败模式挖掘器（防再犯提案）与相变固化器（组合密度抬升）；
 *   ② expand   档案扩展：{@link ArchiveCurator} 执行「入档 → 复活 → 冻结」三段纪律，
 *              负结果不删除、同工况复现复活并经 {@link EliteReentryDiscovery} 重入候选流；
 *   ③ verify   内层控制器（门禁 + RLVR 可验证奖励）真实评估；
 *   ④ gate     内层准入（多样性闸 + 退火接受 + 覆盖率闸）——语义全部留在内层不旁路；
 *   ⑤ snapshot 晋升前快照（`PromotionLedgerPort`：无快照不晋升，治理不变式）；
 *   ⑥ promote  晋升（组合根注入的 `onPromote`，通常 = `registry.replace`）；
 *   ⑦ observe  `evolution.kernel.*` 观测行 + 体检报告。
 *
 * 关键边界：
 * - **实现既有 `EvolutionController` 端口**——`core/agent.ts` 触发点与 `OmniHarnessRuntime`
 *   契约零改动；关掉（`evolutionRlvr.kernel` 缺省 false）即回现状路径。
 * - **晋升裁决权在内层**：本类绝不把未通过门禁/准入的候选改成晋升——本类只对内层
 *   已放行的裁决补齐「快照 → 晋升 → 档案退役」的治理尾巴。
 * - **fail-closed**：任何一环异常只告警（`evolution.kernel.cycle.failed`），绝不连累主任务。
 *
 * @maturity L1 — 七环编排接线真实（判据钉死）；增益未经两关统计，默认关
 * @maturityEvidence tests/unit/evolutionKernel.test.ts
 */
import type {
  Candidate,
  EvolutionController,
  EvolutionSignalSourcePort,
  CandidateArchivePort,
  PromotionLedgerPort,
  PromotionVerdict,
  SkillRestorePlan,
} from '../ports/runtime/evolution.js';
import type { CapabilityCrystallizerPort } from '../ports/intelligence/capability.js';
import type { Skill } from '../skill/skill.js';
import { SignalIngestor } from './signalIngestor.js';
import type { SignalRouteOutcome } from './signalIngestor.js';
import { ArchiveCurator } from './archiveCurator.js';
import type { ArchiveUpdateOutcome } from './archiveCurator.js';
import type { DormantExecutorActivation } from './dormantExecutorActivation.js';
import type { ExecutorActivationReport } from './dormantExecutorActivation.js';
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
  /** 本轮晋升前落下的快照 seq（无晋升或无台账为 undefined）。 */
  readonly snapshotSeq?: number | undefined;
  /** 本轮入档候选数。 */
  readonly archived: number;
  /** 本轮复活并排入下轮重入流的候选数（复核次数超限者不计入）。 */
  readonly revived: number;
  /** 重入队列当前长度（待复核者）。 */
  readonly reentryPending: number;
  /** 降级口径（如信号源缺失 / 档案缺失——装配缺件时如实申报，不静默）。 */
  readonly degraded: readonly string[];
  /** ring ⑥ 执行体转正明细（CRISPR 改进 + 越阈结晶；未装配执行体时为 undefined）。 */
  readonly executors?: ExecutorActivationReport | undefined;
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
  /**
   * 晋升台账端口（ring ⑤）：Kernel 路径下**必需**——治理不变式「无快照不晋升」，
   * 缺失时本轮所有晋升裁决被 fail-closed 改写为未晋升（如实申报，绝不静默放行）。
   */
  readonly ledger?: PromotionLedgerPort | undefined;
  /** 当前技能表读取口（ring ⑤ 快照的数据源；与 `ledger` 成对注入）。 */
  readonly skillsProvider?: (() => readonly Skill[]) | undefined;
  /** 还原计划执行口（`rollback()` 用；组合根注入具体注册表的 replace+remove 语义）。 */
  readonly applyRestore?: ((plan: SkillRestorePlan) => void) | undefined;
  /** 工况桶键派生（ring ②；缺省 = 候选来源算子前缀，透传档案管理员）。 */
  readonly bucketFor?: ((candidate: Candidate) => string) | undefined;
  /** 失败提案升格阈值（默认 3，透传信号路由器）。 */
  readonly failureThreshold?: number | undefined;
  /** 同一候选复活复核次数上限（默认 3；超限退役停复活，透传档案管理员）。 */
  readonly maxRecheckAttempts?: number | undefined;
  /** 失败记录累积上限（默认 512；透传信号路由器）。 */
  readonly maxFailureRecords?: number | undefined;
  /**
   * ring ⑥ 执行体转正（休眠执行体：CRISPR 定点改进 + 相变固化越阈冻结）：
   * 组合根注入；缺省 = 两条转正路径不跑（如实申报进 `degraded`）。
   */
  readonly executors?: DormantExecutorActivation | undefined;
}

/**
 * cycle() 对档案侧的最小依赖面：缺档案端口时以零实现顶替（编排结构不变、零行为）。
 * {@link ArchiveCurator} 结构性满足本面。
 */
interface ArchiveFacet {
  /** 按三段纪律更新档案。 */
  update(verdicts: readonly PromotionVerdict[]): ArchiveUpdateOutcome;
  /** 重入队列长度（缺通道恒 0）。 */
  pending(): number;
}

/** 零实现档案面（未注入档案端口时的降级路径）。 */
const noopArchiveFacet: ArchiveFacet = {
  update: (): ArchiveUpdateOutcome => ({ archived: 0, revived: 0 }),
  pending: (): number => 0,
};

/** 进化内核：七环编排器（实现既有 EvolutionController 端口）。 */
export class EvolutionKernel implements EvolutionController {
  /** 任务末自动进化标志（透传内层，真实控制 Agent 是否跑本轮）。 */
  public readonly autoRun: boolean;
  /** 内层控制器（ring ③④ 的裁决权所在）。 */
  private readonly inner: EvolutionController;
  /** 信号源端口。 */
  private readonly signals?: EvolutionSignalSourcePort | undefined;
  /** 信号路由器（ring ①）。 */
  private readonly ingestor: SignalIngestor;
  /** 档案管理员（ring ②；缺档案端口为零实现）。 */
  private readonly curator: ArchiveFacet;
  /** 真实晋升回调。 */
  private readonly onPromote?: ((candidate: Candidate) => void) | undefined;
  /** 晋升台账端口（ring ⑤）。 */
  private readonly ledger?: PromotionLedgerPort | undefined;
  /** 当前技能表读取口。 */
  private readonly skillsProvider?: (() => readonly Skill[]) | undefined;
  /** 还原计划执行口。 */
  private readonly applyRestore?: ((plan: SkillRestorePlan) => void) | undefined;
  /** 执行体转正（ring ⑥；缺省 = 两条转正路径不跑）。 */
  private readonly executors?: DormantExecutorActivation | undefined;
  /** 装配缺件降级申报（构造时定死；缺什么如实申报什么）。 */
  private readonly degradedBaseline: readonly string[];
  /** 本轮晋升前落下的快照 seq（无晋升 / 台账缺失为 undefined；体检报告数据源）。 */
  private lastSnapshotSeq: number | undefined;
  /** 本轮执行体转正明细（未装配执行体为 undefined；体检报告数据源）。 */
  private lastExecutors: ExecutorActivationReport | undefined;
  /** 最近一轮体检报告。 */
  private lastReport: EvolutionKernelReport | undefined;

  /**
   * @param opts 内层控制器与各环端口（信号源 / 档案 / 重入 / 固化器可缺省，缺件进降级申报）
   */
  public constructor(opts: EvolutionKernelOptions) {
    this.inner = opts.inner;
    this.autoRun = opts.inner.autoRun;
    this.signals = opts.signals;
    this.ingestor = new SignalIngestor({
      crystallizer: opts.crystallizer,
      failureThreshold: opts.failureThreshold,
      maxFailureRecords: opts.maxFailureRecords,
    });
    this.curator =
      opts.archive !== undefined
        ? new ArchiveCurator({
            archive: opts.archive,
            reentry: opts.reentry,
            bucketFor: opts.bucketFor,
            maxRecheckAttempts: opts.maxRecheckAttempts,
          })
        : noopArchiveFacet;
    this.onPromote = opts.onPromote;
    this.ledger = opts.ledger;
    this.skillsProvider = opts.skillsProvider;
    this.applyRestore = opts.applyRestore;
    this.executors = opts.executors;
    const degraded: string[] = [];
    if (opts.signals === undefined) degraded.push('signal-source:missing');
    if (opts.archive === undefined) degraded.push('candidate-archive:missing');
    if (opts.reentry === undefined) degraded.push('elite-reentry:missing');
    if (opts.ledger === undefined) degraded.push('promotion-ledger:missing');
    degraded.push(...(opts.executors?.degraded() ?? ['executors:missing']));
    this.degradedBaseline = degraded;
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
   * @returns 裁决流（ring ⑤ 的 fail-closed 改写可能把晋升者改为未晋升）
   */
  public async cycle(): Promise<readonly PromotionVerdict[]> {
    try {
      const signals = this.signals !== undefined ? this.signals.collect() : [];
      const routed = this.ingestor.ingest(signals);
      const reentryPending = this.curator.pending();
      // 可变副本：ring ⑤ 的 fail-closed 改写（无台账 → 晋升者改未晋升）发生在裁决流上。
      const verdicts: PromotionVerdict[] = [...(await this.inner.cycle())];
      const promoted = this.applyPromotion(verdicts);
      const archived = this.curator.update(verdicts);
      // ring ⑥ 尾：执行体转正（CRISPR 针对既有技能的定点改进 + 相变固化越阈冻结）。
      // 放在晋升/档案之后：改进与冻结都作用于「本轮已定稿的技能表」，不回冲本轮裁决。
      this.lastExecutors = this.executors?.activate(this.ingestor.proposals());
      const report = this.summarize(
        signals.length,
        routed,
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
   * ring ⑤⑥ 晋升：**无快照不晋升**（治理不变式）。
   *
   * - 台账 / 技能表读取口缺失 ⇒ 本轮所有晋升裁决被 fail-closed 改写为未晋升（理由注明），
   *   绝不静默放行——「评估通过」≠「生效」，生效必须有可还原的快照在前；
   * - 正常路径：本轮首个晋升者之前落一次全量快照（seq 记入体检报告），每个晋升者追加
   *   promote 条目；晋升回调单点失败只告警，不连累其余晋升。
   * @param verdicts 内层裁决流（可能被本方法改写：晋升者 → 未晋升）
   * @returns 实际完成晋升回调的候选数
   */
  private applyPromotion(verdicts: PromotionVerdict[]): number {
    this.lastSnapshotSeq = undefined;
    const promotees = verdicts.filter((v) => v.promoted);
    if (promotees.length === 0) return 0;
    if (this.ledger === undefined || this.skillsProvider === undefined) {
      log.warn('evolution.kernel.ledger.missing', {
        blocked: promotees.length,
        invariant: '无快照不晋升（fail-closed）',
      });
      for (let i = 0; i < verdicts.length; i++) {
        const verdict = verdicts[i]!;
        if (!verdict.promoted) continue;
        verdicts[i] = {
          ...verdict,
          promoted: false,
          reason: `${verdict.reason}；台账缺失：无快照不晋升（fail-closed 拒绝生效）`,
        };
      }
      return 0;
    }
    let promoted = 0;
    for (const verdict of promotees) {
      try {
        if (this.lastSnapshotSeq === undefined) {
          this.lastSnapshotSeq = this.ledger.snapshotBefore(this.skillsProvider());
        }
        this.ledger.append({
          name: verdict.candidate.skill.name,
          source: verdict.candidate.source,
        });
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
   * 回滚到指定快照：台账产出还原计划并由 `applyRestore` 执行（技能表恢复为快照态：
   * 表内 replace、快照外新增者 remove）。回滚事件由台账自身入链（治理事件不隐身）。
   * @param seq 回滚目标快照的 seq
   * @returns 已执行的还原计划
   * @throws 台账缺失，或台账定位不到快照（seq 非法）时抛错（fail-closed）
   */
  public rollback(seq: number): SkillRestorePlan {
    if (this.ledger === undefined) {
      throw new Error('晋升台账缺失：无法回滚（Kernel 路径必须装配台账）');
    }
    const plan = this.ledger.rollback(seq);
    this.applyRestore?.(plan);
    log.info('evolution.kernel.rollback', { seq: plan.seq, restored: plan.skills.length });
    return plan;
  }

  /**
   * 汇总本轮体检报告（缺件降级如实申报）。
   * @param signalCount 信号数
   * @param routed 信号路由计数
   * @param reentryPending 重入队列长度（评估前）
   * @param verdicts 裁决流
   * @param promoted 晋升数
   * @param archived 档案更新计数
   * @returns 体检报告
   */
  private summarize(
    signalCount: number,
    routed: SignalRouteOutcome,
    reentryPending: number,
    verdicts: readonly PromotionVerdict[],
    promoted: number,
    archived: ArchiveUpdateOutcome,
  ): EvolutionKernelReport {
    return {
      signals: signalCount,
      failures: routed.failures,
      successObservations: routed.successes,
      proposals: this.ingestor.proposals().map((p) => p.summary),
      evaluated: verdicts.length,
      promoted,
      snapshotSeq: this.lastSnapshotSeq,
      archived: archived.archived,
      revived: archived.revived,
      reentryPending,
      degraded: this.degradedBaseline,
      executors: this.lastExecutors,
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
