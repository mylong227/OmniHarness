import type {
  RetrievalDoc,
  RetrievalHit,
  RetrievalPort,
} from '../../ports/intelligence/retrieval.ts';
import { Bm25Index } from '../../search/bm25Index.ts';

/**
 * @beta
 * 内存 BM25 会话检索引擎（#M2）：复用 #M1 的无第三方依赖 Okapi BM25 内核，
 * 对会话历史事件做全文检索，使模型可跨长对话 recall 历史细节。
 *
 * 索引按「插入顺序」维护文档数组；检索时按需建 BM25 索引。
 *
 * 2026-10-25（F8）：`index()` 在已有内核时走 `addDocument` **增量**，不再把每条新事件
 * 都标脏、下次检索全量重建 1 MB 语料（实测 tokenize/addDocuments ≈0.7 s/次）。
 * `remove()` 会重排数组下标，仍必须整体重建；此时把内核置空，下次检索重建。
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
  /** 全量重建次数（诊断/判据：增量追加不得增加它）。 */
  private rebuildCount = 0;

  /** 索引一条会话文档。
   * @param doc 会话文档（含 sessionId 与正文 text）；有内核时增量追加，否则只入数组待重建。
   * @returns 无返回值。
   */
  public index(doc: RetrievalDoc): void {
    this.docs.push(doc);
    if (this.bm25 === undefined) {
      this.dirty = true;
      return;
    }
    // 刚 push 的文档正好是内核的下一个槽位（插入顺序 = 文档 id）。
    this.bm25.addDocument(Bm25Index.tokenize(doc.text));
    this.dirty = false;
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
    const hits = (this.bm25 as Bm25Index).search(Bm25Index.tokenize(trimmed), limit);
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

  /** 全量重建次数（诊断用；增量追加不增加）。 */
  public get rebuilds(): number {
    return this.rebuildCount;
  }

  /**
   * 反注册若干文档（检查点回滚后清理「已被撤销」的召回源）。
   *
   * 实现说明：`docs` 是数组（下标即 BM25 文档 id），故移除后必须整体重建——不能只标记脏，
   * 因为 `rebuild()` 用的是数组**当前**下标，过滤后下标自然重排，命中 id 与 `docs[hit.id]`
   * 仍严格对齐（这正是本类无需 map 的原因）。
   * @param ids 要移除的文档 id（不存在的 id 静默忽略）。
   * @returns 实际移除的文档数。
   */
  public remove(ids: readonly string[]): number {
    if (ids.length === 0 || this.docs.length === 0) {
      return 0;
    }
    const drop = new Set(ids);
    const kept = this.docs.filter((doc) => !drop.has(doc.id));
    const removed = this.docs.length - kept.length;
    if (removed > 0) {
      this.docs = kept;
      // 下标整体重排，增量内核无法原地修正；置空并在下次检索重建。
      this.bm25 = undefined;
      this.dirty = true;
    }
    return removed;
  }

  /** 用全量文档重建 BM25 索引（插入顺序即文档下标，与命中 id 对齐）。
   * @returns 无返回值。
   */
  private rebuild(): void {
    const next = new Bm25Index();
    next.addDocuments(this.docs.map((doc) => Bm25Index.tokenize(doc.text)));
    this.bm25 = next;
    this.dirty = false;
    this.rebuildCount += 1;
  }
}
