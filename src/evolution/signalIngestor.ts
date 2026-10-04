/**
 * 信号路由器（GEE Kernel v1 · ① ingest 环的路由策略，ADR-0008）。
 *
 * 双源信号归纳的落点：failure 信号进失败模式挖掘器（跨轮有界累积 → 同签名高频者
 * 升格「防再犯」提案），success 信号的组合喂相变固化器（经验密度抬升，越阈冻结）。
 * 从 {@link EvolutionKernel} 拆出的独立职责——路由策略可单测、可替换，Kernel 只管编排。
 *
 * @maturity L1 — 路由接线真实（信号→挖掘器/固化器端到端判据）；增益假设未验证
 * @maturityEvidence tests/unit/signalIngestor.test.ts
 */
import type { EvolutionSignal } from '../ports/runtime/evolution.js';
import type { CapabilityCrystallizerPort } from '../ports/intelligence/capability.js';
import { FailurePatternMiner } from './failurePatternMiner.js';
import type { FailureRecord, ImprovementProposal } from './failurePatternMiner.js';

/** 信号路由结果（Kernel 体检报告数据源）。 */
export interface SignalRouteOutcome {
  /** 路由进失败挖掘器的失败信号数。 */
  readonly failures: number;
  /** 喂给固化器的成功组合观测数。 */
  readonly successes: number;
}

/** 信号路由器选项。 */
export interface SignalIngestorOptions {
  /** 相变固化器端口（success 组合密度去向；缺省 = 只统计不观测）。 */
  readonly crystallizer?: CapabilityCrystallizerPort | undefined;
  /** 失败提案升格阈值（默认 3，透传失败模式挖掘器）。 */
  readonly failureThreshold?: number | undefined;
  /** 失败记录累积上限（默认 512；超出淘汰最旧者，有界缓冲）。 */
  readonly maxFailureRecords?: number | undefined;
}

/** 信号路由器：failure → 挖掘器 / success → 固化器。 */
export class SignalIngestor {
  /** 相变固化器端口。 */
  private readonly crystallizer?: CapabilityCrystallizerPort | undefined;
  /** 失败模式挖掘器（生产失败信号的防再犯提案来源）。 */
  private readonly miner: FailurePatternMiner;
  /** 失败记录累积上限。 */
  private readonly maxFailureRecords: number;
  /** 跨轮累积的失败记录（挖掘器输入；有界）。 */
  private readonly failureRecords: FailureRecord[] = [];

  /**
   * @param opts 固化器 / 提案阈值 / 失败记录上限（缺省各取保守默认）
   */
  public constructor(opts: SignalIngestorOptions = {}) {
    this.crystallizer = opts.crystallizer;
    this.miner = new FailurePatternMiner(opts.failureThreshold ?? 3);
    this.maxFailureRecords = Math.max(1, Math.floor(opts.maxFailureRecords ?? 512));
  }

  /**
   * 路由一批信号：失败进挖掘器（有界累积），成功组合喂固化器（密度抬升）。
   * @param signals 本轮采集的信号流
   * @returns 路由计数
   */
  public ingest(signals: readonly EvolutionSignal[]): SignalRouteOutcome {
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
   * 失败模式挖掘：对跨轮累积的失败历史聚类，高频签名升格为改进提案（频次降序，确定性）。
   * @returns 当前改进提案集
   */
  public proposals(): readonly ImprovementProposal[] {
    return this.miner.mine(this.failureRecords).proposals;
  }
}
