/**
 * 资产类型描述符（ADR-0009 · EVOLVIX_SPEC §1.1；L1 协议的核心）。
 *
 * 一种「可进化对象」的完整自描述：**类型键 + 版本 + 结构校验 + 评估契约 + 默认信任/隔离档 + 台账语义**。
 * 有了它，接入一种新资产类型 = 新写一个 schema 文件 + 一条注册调用，Kernel 与治理层零改动
 * （目标架构的「上限轴 1：资产类型开放」）。
 *
 * 两条纪律（Ω-4 / Ω-2）：
 * - **度量由类型作者声明**：`evalContract` 返回该类型资产的门禁基准函数，而不是「所有类型共用一个分」
 *   ——在正确的空间里比较（沿 Wave A 的覆盖率分桶同一取向）；
 * - **台账语义显式化**：该类型的变更走哪条链、快照粒度是全表还是单资产，由类型声明，
 *   注册表按声明执行（而不是让每个调用点各自猜）。
 */
import type { IsolationLevel } from './isolationLevel.js';
import type { TrustTier } from './trustTier.js';

/**
 * 资产级基准函数：资产 → 0..1 得分。
 *
 * **为什么不直接复用 `evolution/failClosedEvolutionGate` 的 `BenchmarkFn`**：那个签名收窄在
 * `Candidate`（技能候选）上，而本协议要能描述**任意**资产类型；端口恒不依赖实现层（Ω-0）。
 * 从 `AssetBenchmark` 到门禁 `BenchmarkFn` 的桥接属实现层职责（Wave B 的评估器做这件事）。
 */
export type AssetBenchmark = (asset: unknown) => number | Promise<number>;

/** 结构校验结论（fail-closed：`ok: false` 必须带**可行动**的原因，进审计与错误消息）。 */
export type SchemaValidation =
  { readonly ok: true } | { readonly ok: false; readonly reason: string };

/** 评估上下文（类型作者的 `evalContract` 用它决定怎么量）。 */
export interface EvalContext {
  /** 评估器标识（进 `CapabilityRecord.fitness.evaluator` 与审计）。 */
  readonly evaluator: string;
  /**
   * 候选资产所属工况桶键（可选）：分桶口径由类型作者与调度方协商，
   * 注册表只透传不解释（沿 Wave A「工况桶键语义归调用方」的同一决定）。
   */
  readonly bucketKey?: string | undefined;
}

/** 资产类型描述符。 */
export interface CapabilitySchema {
  /** 类型键（如 `'skill'` / `'workflow-template'` / `'operator'`）。 */
  readonly kind: string;
  /** 契约版本（跨版本注册须走迁移器；当前唯一合法值 1）。 */
  readonly version: 1;
  /**
   * 结构校验（fail-closed）：非法资产在注册口即拒，判据由类型作者声明。
   * @param asset 待校验资产（`unknown`：校验器负责收窄）
   * @returns 校验结论（失败必带原因）
   */
  validate(asset: unknown): SchemaValidation;
  /**
   * 评估契约：返回该类型资产的门禁基准函数（Ω-4：度量是一等公民）。
   * @param ctx 评估上下文（评估器标识 + 可选工况桶键）
   * @returns 资产级基准函数（0..1）
   */
  evalContract(ctx: EvalContext): AssetBenchmark;
  /** 默认信任档（可被签名元数据收紧，**不可放宽**——§6 矩阵）。 */
  readonly defaultTrustTier: TrustTier;
  /** 默认隔离档（同上，只可收紧）。 */
  readonly defaultIsolation: IsolationLevel;
  /** 台账语义：该类型的状态变更走哪条链、快照粒度。 */
  readonly ledgerSemantics: {
    /** 链名（当前只有 `promotion` 一条）。 */
    readonly chain: 'promotion';
    /** 快照粒度：`registry-full` = 全注册表快照（Wave A 台账已实现的那一种）。 */
    readonly snapshot: 'registry-full';
  };
}
