import type { RetrievalDoc } from './retrievalDoc.js';
import type { RetrievalHit } from './retrievalHit.js';

/**
 * @beta
 * 检索端口：对会话历史做全文/语义检索，使模型可跨长对话 recall，
 * 无需把全部历史塞进上下文。无第三方依赖后端用 BM25（#M2，复用 #M1 检索内核）。
 */
export interface RetrievalPort {
  readonly name: string;
  /** 索引一条会话文档。 */
  index(doc: RetrievalDoc): void;
  /** 检索：自然语言查询 → 降序得分片段，可限定 sessionId。 */
  search(query: string, limit: number, sessionId?: string): readonly RetrievalHit[];
}
