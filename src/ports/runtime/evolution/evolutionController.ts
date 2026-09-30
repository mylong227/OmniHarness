import type { Candidate } from './candidate.js';
import type { PromotionVerdict } from './promotionVerdict.js';

/** 进化控制器：编排 发现 → 评估 → 晋升 一轮闭环。 */
export interface EvolutionController {
  /** 评估单个候选（直接转发门禁）。 */
  evaluate(candidate: Candidate): Promise<PromotionVerdict>;
  /** 跑一轮：取本批候选 → 逐一评估 → 晋升者触发 onPromote。 */
  cycle(): Promise<readonly PromotionVerdict[]>;
  /** 当前预算消耗。 */
  budgetUsed(): { readonly generated: number; readonly maxCandidates: number };
  /** 是否任务完成后自动进化。 */
  readonly autoRun: boolean;
}
