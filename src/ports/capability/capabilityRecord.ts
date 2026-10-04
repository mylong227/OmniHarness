/**
 * 资产实例（ADR-0009 · EVOLVIX_SPEC §1.2）：本体 + 溯源 + 适应度 + 治理状态。
 *
 * 设计取向：`asset` 保持 `unknown`——**由所属 `CapabilitySchema.validate` 把关**，注册表不猜结构。
 * 这样接入新类型不需要改本文件（上限轴 1），也不会出现「注册表里塞了半个类型的字段」。
 *
 * 三个附加面的用途：
 * - `lineage`：溯源，可渲染为「进化系谱」（谁生了它、用哪个算子、什么时候）；
 * - `fitness`：最近一次评估（评估器写入，**只增不改**），`ledgerSeq` 之外的第二个可审计锚点；
 * - `governance`：信任档 / 隔离档 / 状态 / 最近一次状态变化的台账序号——**任何变更必须留台账**
 *   （波次的「无台账不生效」纪律）。
 */
import type { IsolationLevel } from './isolationLevel.js';
import type { TrustTier } from './trustTier.js';

/** 溯源（资产从哪来）。 */
export interface CapabilityLineage {
  /** 来源资产名 / 父候选名（空数组 = 原生新建）。 */
  readonly parents: readonly string[];
  /** 产生它的算子（如 `'twist:a+b'` / `'crispr'` / `'pack:install'`）。 */
  readonly operator: string;
  /** 出生时间（ISO 时间戳；由调用方注入，注册表不读墙钟）。 */
  readonly bornAt: string;
}

/** 最近一次评估（评估器写入，只增不改）。 */
export interface CapabilityFitness {
  /** 基准得分（0..1）。 */
  readonly benchmark: number;
  /** 评估时间（ISO 时间戳，由评估器注入）。 */
  readonly evaluatedAt: string;
  /** 评估器标识（与审计条目对应）。 */
  readonly evaluator: string;
}

/** 治理状态（信任档 / 隔离档 / 生命周期 / 台账锚点）。 */
export interface CapabilityGovernance {
  /** 信任档（谁签的字）。 */
  readonly trustTier: TrustTier;
  /** 隔离档（跑在哪）。 */
  readonly isolation: IsolationLevel;
  /** 生命周期状态。 */
  readonly state: 'active' | 'frozen' | 'revoked';
  /** 最近一次状态变化对应的台账序号（未入账为 undefined）。 */
  readonly ledgerSeq: number | undefined;
}

/** 资产实例。 */
export interface CapabilityRecord {
  /** 资产本体（由所属 Schema.validate 把关）。 */
  readonly asset: unknown;
  /** 所属类型键（必须是已注册的 `CapabilitySchema.kind`）。 */
  readonly schemaKind: string;
  /** 溯源。 */
  readonly lineage: CapabilityLineage;
  /** 最近一次评估（未评估为 undefined）。 */
  readonly fitness: CapabilityFitness | undefined;
  /** 治理状态。 */
  readonly governance: CapabilityGovernance;
}
