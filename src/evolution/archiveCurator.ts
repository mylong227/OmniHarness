/**
 * 档案管理员（GEE Kernel v1 · ② expand 环的档案纪律，ADR-0008）。
 *
 * 候选裁决流与 {@link CandidateArchivePort} 之间的策略层：
 * - 评估完毕的候选按工况桶入档（精英保留），晋升者 `promoted` 退役、被拒者 `rejected:*` 暂停；
 * - 本轮活跃桶的**早前轮次**冻结者复活（负结果不删除、同工况复现复活），未超复核上限者
 *   排入 {@link EliteReentryDiscovery} 重入下轮候选流；
 * - 复核次数超限者退役停复活（防「拒绝 ⇄ 复活」永动空转——复核成本是评估预算的一部分）。
 *
 * 顺序纪律（判据钉死）：入档 → 复活旧冻结者 → 冻结本轮裁决。复活必须在冻结**之前**，
 * 否则同轮冻结者被同轮复活——复活是对早前负结果的第二次机会，不是无间隔重采样。
 *
 * @maturity L1 — 冻结/复活/退役纪律判据钉死（含复核上限判据）
 * @maturityEvidence tests/unit/archiveCurator.test.ts
 */
import type {
  Candidate,
  CandidateArchivePort,
  PromotionVerdict,
} from '../ports/runtime/evolution.js';
import type { EliteReentryDiscovery } from './eliteReentryDiscovery.js';

/** 复核次数超限后的冻结 reason（退役申报，观测可辨）。 */
const RETIRE_AFTER_RECHECKS = 'rejected:rechecks-exhausted';

/** 档案更新结果（Kernel 体检报告数据源）。 */
export interface ArchiveUpdateOutcome {
  /** 本轮入档候选数。 */
  readonly archived: number;
  /** 本轮复活并排入下轮重入流的候选数（复核超限者不计入）。 */
  readonly revived: number;
}

/** 档案管理员选项。 */
export interface ArchiveCuratorOptions {
  /** 候选档案端口。 */
  readonly archive: CandidateArchivePort;
  /** 精英重入发现引擎（缺省 = 复活者不重入，只归档）。 */
  readonly reentry?: EliteReentryDiscovery | undefined;
  /** 工况桶键派生（缺省 = 候选来源算子前缀，如 `twist:a+b` → `twist`）。 */
  readonly bucketFor?: ((candidate: Candidate) => string) | undefined;
  /** 同一候选复活复核次数上限（默认 3；超限退役停复活）。 */
  readonly maxRecheckAttempts?: number | undefined;
}

/** 档案管理员：入档 → 复活 → 冻结的三段纪律执行者。 */
export class ArchiveCurator {
  /** 候选档案端口。 */
  private readonly archive: CandidateArchivePort;
  /** 精英重入发现引擎。 */
  private readonly reentry?: EliteReentryDiscovery | undefined;
  /** 工况桶键派生。 */
  private readonly bucketFor: (candidate: Candidate) => string;
  /** 复核次数上限。 */
  private readonly maxRecheckAttempts: number;
  /** 候选名 → 已复核次数（复活重入后仍被拒即 +1；超限退役）。 */
  private readonly rechecks = new Map<string, number>();

  /**
   * @param opts 档案端口 / 重入通道 / 桶键派生 / 复核上限（缺省各取保守默认）
   */
  public constructor(opts: ArchiveCuratorOptions) {
    this.archive = opts.archive;
    this.reentry = opts.reentry;
    this.bucketFor = opts.bucketFor ?? ArchiveCurator.defaultBucketFor;
    this.maxRecheckAttempts = Math.max(0, Math.floor(opts.maxRecheckAttempts ?? 3));
  }

  /**
   * 重入队列当前长度（待复核者；Kernel 体检报告数据源）。
   * @returns 队列中待重入候选数（无重入通道恒 0）
   */
  public pending(): number {
    return this.reentry !== undefined ? this.reentry.pending() : 0;
  }

  /**
   * 按三段纪律更新档案：入档（精英保留）→ 复活本轮活跃桶的早前冻结者 → 冻结本轮裁决。
   * @param verdicts 内层裁决流（含最终晋升语义：promoted 者退役，其余暂停）
   * @returns 档案更新计数
   */
  public update(verdicts: readonly PromotionVerdict[]): ArchiveUpdateOutcome {
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
   * 默认工况桶键：候选来源的算子前缀（`twist:a+b` → `twist`；无前缀取全串）。
   * @param candidate 候选
   * @returns 工况桶键
   */
  private static defaultBucketFor(candidate: Candidate): string {
    const sep = candidate.source.indexOf(':');
    return sep > 0 ? candidate.source.slice(0, sep) : candidate.source;
  }
}
