import type { CodeCandidate } from './codeCandidate.js';

/**
 * @beta
 * 单轮 RLVR 结果。
 *
 * 2026-10-11 从 `src/evolution/rlvrLoop.ts` 外迁至端口层（同 `codeCandidate.ts` 的理由）。
 */
export interface RlvrRoundResult {
  /** 本轮回放缓冲新增的绿样本数。 */
  readonly kept: number;
  /** 本轮最佳候选（按奖励），无绿样本则为 undefined。 */
  readonly best: { readonly candidate: CodeCandidate; readonly reward: number } | undefined;
  /** 本轮回放缓冲累计大小。 */
  readonly bufferSize: number;
}
