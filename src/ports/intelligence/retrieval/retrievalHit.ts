import type { RetrievalDoc } from './retrievalDoc.js';

/**
 * @beta
 * 单条检索命中。
 */
export interface RetrievalHit {
  readonly doc: RetrievalDoc;
  readonly score: number;
}
