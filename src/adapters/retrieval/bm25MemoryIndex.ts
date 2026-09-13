import type {
  RetrievalDoc,
  RetrievalHit,
  RetrievalPort,
} from '../../ports/intelligence/retrieval.js';
import { Bm25Index, tokenize } from '../../search/bm25Index.js';

/**
 * @beta
 * 内存 BM25 会话检索引擎（#M2）：复用 #M1 的零依赖 Okapi BM25 内核，
 * 对会话历史事件做全文检索，使模型可跨长对话 recall 历史细节。
 *
 * 索引按「插入顺序」维护文档数组；检索时按需用全量文档重建 BM25 索引
 * （会话规模通常数百条，重建代价可忽略，且规避 `Bm25Index.addDocuments`
 * 增量调用下 `averageLength` 仅统计增量批次的缺陷，保证打分正确）。
 */
export class Bm25MemoryIndex implements RetrievalPort {
  /** 适配器名，与端口契约一致：固定为 'bm25-memory'。 */
  public readonly name = 'bm25-memory';

  /** 已索引文档数组（插入顺序即文档 id）。 */
  private docs: RetrievalDoc[] = [];
  /** 惰性重建的 BM25 内核（首次检索或标记脏后重建）。 */
  private bm25: Bm25Index | undefined;
  /** 索引脏标记：docs 有新增而 bm25 尚未重建时为 true。 */
  private dirty = false;

  /** 索引一条会话文档。
   * @param doc 会话文档（含 sessionId 与正文 text）；只入数组不立即建索引。
   
 * @returns 无返回值。
*/
  public index(doc: RetrievalDoc): void {
    this.docs.push(doc);
    this.dirty = true;
  }

  /** 检索：自然语言查询 → 降序得分片段，可限定 sessionId。
   * @param query 自然语言查询（空白查询直接返回空）。
   * @param limit 返回条数上限（<=0 返回空）。
   * @param sessionId 可选会话过滤：仅返回该会话的文档。
   * @returns 按得分降序的命中列表（文档 + BM25 得分）；必要时先全量重建索引。
   */
  public search(query: string, limit: number, sessionId?: string): readonly RetrievalHit[] {
    const trimmed = query.trim();
    if (trimmed === '' || limit <= 0) {
      return [];
    }
    if (this.dirty || this.bm25 === undefined) {
      this.rebuild();
    }
    const hits = (this.bm25 as Bm25Index).search(tokenize(trimmed), limit);
    const result: RetrievalHit[] = [];
    for (const hit of hits) {
      const doc = this.docs[hit.id];
      if (doc === undefined) {
        continue;
      }
      if (sessionId !== undefined && doc.sessionId !== sessionId) {
        continue;
      }
      result.push({ doc, score: hit.score });
    }
    return result;
  }

  /** 当前索引文档数。
   * @returns 已索引（含未重建）的文档总数。
   */
  public get size(): number {
    return this.docs.length;
  }

  /** 用全量文档重建 BM25 索引（插入顺序即文档下标，与命中 id 对齐）。
   * @returns 无返回值。
   */
  private rebuild(): void {
    const next = new Bm25Index();
    next.addDocuments(this.docs.map((doc) => tokenize(doc.text)));
    this.bm25 = next;
    this.dirty = false;
  }
}
