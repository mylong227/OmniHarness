import type { Candidate } from './candidate.js';

/**
 * 发现引擎（沙箱有界探索）：在 discoveryBudget 硬上限内生成候选能力。
 * 严禁在预算外自改；绝不暴露裸能力（颜色单态约束由上游 SupervisorPort 兜底）。
 */
export interface DiscoveryEngine {
  /** 生成下一批候选（受 budget 约束，返回空数组 = 预算耗尽）。 */
  nextCandidates(): Candidate[];
  /** 当前预算消耗情况。 */
  budgetUsed(): { readonly generated: number; readonly maxCandidates: number };
}
