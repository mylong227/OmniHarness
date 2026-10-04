/**
 * 信号路由器（GEE Kernel v1 · ① ingest 环的路由策略，ADR-0008；**E1+ 扩为真正的双源**）。
 *
 * 双源信号归纳的落点：
 * - failure 信号 → 失败模式挖掘器（跨轮有界累积 → 同签名高频者升格「防再犯」提案）；
 * - success 信号 → ①相变固化器（经验密度抬升，越阈冻结成**技能**）；
 *   ②**成功侧蒸馏器**（E1+：成功轨迹 → **工作流模板候选**）。
 *
 * ①② 目的不同：固化器求**单点能力**，模板蒸馏求**流程复用**。缺 ② 时"成功半边"没有进候选池的路径
 * （实测：`workflow-template` 此前只有 schema 注册、零候选生产者）。
 * 从 {@link EvolutionKernel} 拆出的独立职责——路由策略可单测、可替换，Kernel 只管编排。
 *
 * @maturity L1 — 双源路由接线真实（两侧各有端到端判据 + 掐断任一半边对应候选恒 0 的红线判据）
 * @maturityEvidence tests/unit/signalIngestor.test.ts
 */
import type { EvolutionSignal } from '../ports/runtime/evolution.js';
import type { CapabilityCrystallizerPort } from '../ports/intelligence/capability.js';
import { FailurePatternMiner } from './failurePatternMiner.js';
import type { FailureRecord, ImprovementProposal } from './failurePatternMiner.js';
import { SuccessPatternDistiller } from './successPatternDistiller.js';
import type { WorkflowTemplateCandidate } from './successPatternDistiller.js';

/** 信号路由结果（Kernel 体检报告数据源）。 */
export interface SignalRouteOutcome {
  /** 路由进失败挖掘器的失败信号数。 */
  readonly failures: number;
  /** 喂给固化器的成功组合观测数。 */
  readonly successes: number;
  /** 喂给成功侧蒸馏器的成功观测数（E1+；不含被 provenance/成员数挡下的信号）。 */
  readonly distilled: number;
}

/** 信号路由器选项。 */
export interface SignalIngestorOptions {
  /** 相变固化器端口（success 组合密度去向；缺省 = 只统计不观测）。 */
  readonly crystallizer?: CapabilityCrystallizerPort | undefined;
  /** 失败提案升格阈值（默认 3，透传失败模式挖掘器）。 */
  readonly failureThreshold?: number | undefined;
  /** 失败记录累积上限（默认 512；超出淘汰最旧者，有界缓冲）。 */
  readonly maxFailureRecords?: number | undefined;
  /** 成功侧蒸馏器（E1+：成功轨迹 → 工作流模板候选；缺省 = 只走固化器，行为与既有版本一致）。 */
  readonly distiller?: SuccessPatternDistiller | undefined;
}

/** 信号路由器：failure → 挖掘器 / success → 固化器 + 模板蒸馏器。 */
export class SignalIngestor {
  /** 相变固化器端口。 */
  private readonly crystallizer?: CapabilityCrystallizerPort | undefined;
  /** 成功侧蒸馏器（E1+）。 */
  private readonly distiller?: SuccessPatternDistiller | undefined;
  /** 失败模式挖掘器（生产失败信号的防再犯提案来源）。 */
  private readonly miner: FailurePatternMiner;
  /** 失败记录累积上限。 */
  private readonly maxFailureRecords: number;
  /** 跨轮累积的失败记录（挖掘器输入；有界）。 */
  private readonly failureRecords: FailureRecord[] = [];

  /**
   * @param opts 固化器 / 蒸馏器 / 提案阈值 / 失败记录上限（缺省各取保守默认）
   */
  public constructor(opts: SignalIngestorOptions = {}) {
    this.crystallizer = opts.crystallizer;
    this.distiller = opts.distiller;
    this.miner = new FailurePatternMiner(opts.failureThreshold ?? 3);
    this.maxFailureRecords = Math.max(1, Math.floor(opts.maxFailureRecords ?? 512));
  }

  /**
   * 路由一批信号：失败进挖掘器（有界累积），成功组合喂固化器并送成功侧蒸馏器。
   * @param signals 本轮采集的信号流
   * @returns 路由计数（含成功侧被接受为观测的条数）
   */
  public ingest(signals: readonly EvolutionSignal[]): SignalRouteOutcome {
    let failures = 0;
    let successes = 0;
    let distilled = 0;
    for (const signal of signals) {
      if (signal.kind === 'failure' && signal.failure !== undefined) {
        this.failureRecords.push(signal.failure);
        failures++;
        continue;
      }
      if (signal.kind === 'success' && signal.success !== undefined) {
        this.crystallizer?.observe(signal.success.combination);
        successes++;
        if (this.distiller?.observe(signal) === true) distilled++;
      }
    }
    if (this.failureRecords.length > this.maxFailureRecords) {
      this.failureRecords.splice(0, this.failureRecords.length - this.maxFailureRecords);
    }
    return { failures, successes, distilled };
  }

  /**
   * 失败模式挖掘：对跨轮累积的失败历史聚类，高频签名升格为改进提案（频次降序，确定性）。
   * @returns 当前改进提案集
   */
  public proposals(): readonly ImprovementProposal[] {
    return this.miner.mine(this.failureRecords).proposals;
  }

  /**
   * 成功侧蒸馏（E1+）：成功轨迹归纳为工作流模板候选（未接蒸馏器时恒空）。
   * @returns 当前工作流模板候选
   */
  public workflowTemplateProposals(): readonly WorkflowTemplateCandidate[] {
    return this.distiller?.proposals() ?? [];
  }
}
