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
  /**
   * 反注册若干文档（按 `RetrievalDoc.id`）。
   *
   * 存在理由（2026-10-03，检查点回滚）：回滚会截断会话事件流，而被截断区间里的
   * assistant / tool_result 文本此前仍留在检索索引里 ⇒ 模型能经 `memory_search`
   * 召回**已被用户撤销**的历史（用户回滚到检查点 A，却还能搜到 A 之后的结论）。
   * 端口无删除能力时这一层无法闭合。
   *
   * **可选**：本端口为 `@beta` 公共契约，新增必需方法会破坏既有第三方实现；
   * 不支持反注册的后端可省略，此时回滚路径**只能**保留陈旧召回源（调用方须在
   * 诊断中如实呈现，不得声称「已彻底回滚」）。
   * @param ids 要移除的文档 id（不存在的 id 静默忽略）。
   * @returns 实际移除的文档数（可选实现可返回 0 表示「不追踪」）。
   */
  remove?(ids: readonly string[]): number;
}
