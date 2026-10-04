/**
 * 算子端口（Wave B · ADR-0009 / EVOLVIX_SPEC §2）：资产进化的**变异/发现**面。
 *
 * 与既有 `DiscoveryEngine`（`ports/runtime/evolution/discoveryEngine.ts`）的分工：
 * `DiscoveryEngine` 是「从技能池组合出候选」的**具体机制**；`OperatorPort` 是**面向资产**的算子契约——
 * 它多带一个 `EvolutionContext`（工况桶键 + 当前预算），使「算子按工况调度」成为可能
 * （目标态 Ω-3：发现/变异/课程的算子都可插拔，且**算子本身也能成为资产**，那是 Wave E）。
 *
 * 失败语义（沿 `DiscoveryEngine` 的既有约束，不放松）：
 * - **预算外不自改**：本端口只读预算、只产出候选，绝不自行改注册表；
 * - **输出必须带 lineage**：候选的 `source` 就是它的出身（`twist:a+b` / `crispr` / `pack:install`），
 *   资产入册时由注册表写入 `CapabilityRecord.lineage`——溯源不是可选项（Ω-2 恒等式的一半）。
 */
import type { Candidate } from './candidate.js';

/** 算子调度上下文（按工况取算子 / 读预算）。 */
export interface EvolutionContext {
  /**
   * 本轮的工况桶键（可选）：由调度方声明，算子据此决定用哪种变异
   * （沿 Wave A「工况桶键语义归调用方」的同一决定——Kernel 只透传不解释）。
   */
  readonly bucketKey?: string | undefined;
  /** 当前发现预算消耗（算子必须尊重上限：`generated` 已达 `maxCandidates` 即应返回空批）。 */
  readonly budget: {
    /** 已生成候选数。 */
    readonly generated: number;
    /** 候选数上限。 */
    readonly maxCandidates: number;
  };
}

/** 算子端口：给定上下文产出候选（有界、确定性、带 lineage）。 */
export interface OperatorPort {
  /**
   * 产出一批候选。
   * @param ctx 调度上下文（工况桶键 + 预算）
   * @returns 候选列表（空数组 = 本轮无产出/预算耗尽；顺序须确定性）
   */
  propose(ctx: EvolutionContext): readonly Candidate[];
}
