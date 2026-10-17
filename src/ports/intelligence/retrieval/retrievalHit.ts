import type { RetrievalDoc } from './retrievalDoc.ts';

/**
 * @beta
 * 单条检索命中。
 */
export interface RetrievalHit {
  readonly doc: RetrievalDoc;
  readonly score: number;
}
