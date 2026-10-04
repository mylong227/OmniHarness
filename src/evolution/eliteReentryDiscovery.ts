/**
 * 精英重入发现引擎（GEE Kernel v1 · ② expand 环的候选流注入器，ADR-0008）。
 *
 * 解决的问题：`TwistDiscoveryEngine` 只产出「新组合」候选——档案里冻结复活的精英
 * 与负结果复核者没有进入候选流的通道。本器把档案复活条目排入重入队列，并在每轮
 * `nextCandidates()` 时**优先**吐出重入者（受每轮上限约束），其余预算让给内层
 * （twist 组合）发现——「负结果不删除只冻结，同工况复现复活」由此闭环。
 *
 * 确定性：重入队列 FIFO（排入序即吐出序）；每轮吐出 ≤ `maxReentryPerCycle`，
 * 队列长度硬上限防无界膨胀（超限丢弃**最新**者——旧复核优先）。
 *
 * @maturity L1 — 重入通道接线真实（判据钉死）；重入复核的增益未验证
 * @maturityEvidence tests/unit/evolutionKernel.test.ts
 */
import type { Candidate, DiscoveryEngine } from '../ports/runtime/evolution.js';

/** 精英重入发现引擎选项。 */
export interface EliteReentryDiscoveryOptions {
  /** 内层发现引擎（twist 组合；重入者吐尽后的预算去向）。 */
  readonly inner: DiscoveryEngine;
  /** 每轮最多吐出的重入候选数（默认 4）。 */
  readonly maxReentryPerCycle?: number | undefined;
  /** 重入队列硬上限（默认 128；超限丢弃最新者）。 */
  readonly maxQueue?: number | undefined;
}

/** 精英重入发现引擎：档案复活精英 → 候选流的重入通道。 */
export class EliteReentryDiscovery implements DiscoveryEngine {
  /** 内层发现引擎。 */
  private readonly inner: DiscoveryEngine;
  /** 每轮重入吐出上限。 */
  private readonly maxReentryPerCycle: number;
  /** 队列硬上限。 */
  private readonly maxQueue: number;
  /** 重入队列（FIFO）。 */
  private readonly queue: Candidate[] = [];

  /**
   * @param opts 内层发现引擎 / 每轮重入上限 / 队列上限（缺省各取保守默认）
   */
  public constructor(opts: EliteReentryDiscoveryOptions) {
    this.inner = opts.inner;
    this.maxReentryPerCycle = Math.max(1, Math.floor(opts.maxReentryPerCycle ?? 4));
    this.maxQueue = Math.max(this.maxReentryPerCycle, Math.floor(opts.maxQueue ?? 128));
  }

  /**
   * 排入重入候选（Kernel 在评估后把复活条目排入，供下一轮 `nextCandidates` 吐出）。
   * @param candidates 重入候选
   * @returns 无返回值（void）
   */
  public enqueue(candidates: readonly Candidate[]): void {
    for (const candidate of candidates) {
      this.queue.push(candidate);
      if (this.queue.length > this.maxQueue) this.queue.shift();
    }
  }

  /**
   * 当前重入队列长度（观测面）。
   * @returns 队列中待重入候选数
   */
  public pending(): number {
    return this.queue.length;
  }

  /**
   * 生成下一批候选：先吐重入者（FIFO，≤ 每轮上限），再让内层发现补足（其自带预算）。
   * @returns 本批候选（重入者在前，twist 新组合在后）
   */
  public nextCandidates(): Candidate[] {
    const out: Candidate[] = [];
    while (this.queue.length > 0 && out.length < this.maxReentryPerCycle) {
      const next = this.queue.shift();
      if (next !== undefined) out.push(next);
    }
    out.push(...this.inner.nextCandidates());
    return out;
  }

  /**
   * 预算消耗：转发内层（重入者受每轮上限约束，不计入发现预算——口径见模块注释）。
   * @returns 内层预算消耗
   */
  public budgetUsed(): { readonly generated: number; readonly maxCandidates: number } {
    return this.inner.budgetUsed();
  }
}
