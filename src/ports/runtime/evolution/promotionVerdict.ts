import type { Candidate } from './candidate.js';

/** 晋升/隔离裁决（fail-closed 可读）。 */
export interface PromotionVerdict {
  /** 被裁决的候选。 */
  readonly candidate: Candidate;
  /** 是否被晋升（默认 false）。 */
  readonly promoted: boolean;
  /** 候选在基准上的得分 0..1。 */
  readonly score: number;
  /** 对照基线得分 0..1。 */
  readonly baselineScore: number;
  /** 安全检查结论。 */
  readonly safety: 'pass' | 'blocked';
  /** 裁决理由（可读，便于审计）。 */
  readonly reason: string;
}
