import type { Candidate } from './candidate.js';
import type { PromotionVerdict } from './promotionVerdict.js';

/**
 * 进化门禁（fail-closed 评估 + 晋升）。
 * 任何候选必须过「真实基准评估 + 安全检查」才晋升；默认拒绝。
 */
export interface EvolutionGate {
  /** 用真实基准评估候选，返回是否晋升（含对照基线对比 + 安全结论）。 */
  evaluate(candidate: Candidate): Promise<PromotionVerdict>;
}
