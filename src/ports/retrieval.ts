/**
 * @beta
 * 可被检索索引的会话内容角色。
 */
export type RetrievalRole = 'user' | 'assistant' | 'tool' | 'system';

/**
 * @beta
 * 一条被索引的会话文档（来自会话事件的可检索文本）。
 */
export interface RetrievalDoc {
  /** 来源事件 ID。 */
  readonly id: string;
  /** 所属会话 ID（支持按会话过滤检索）。 */
  readonly sessionId: string;
  /** 会话内序号（同会话下单调递增，用于排序/去重）。 */
  readonly seq: number;
  /** 内容角色。 */
  readonly role: RetrievalRole;
  /** 可检索文本（用户输入 / 助手回复 / 工具输出 / 系统说明）。 */
  readonly text: string;
  /** 事件时间戳（ISO）。 */
  readonly ts: string;
}

/**
 * @beta
 * 单条检索命中。
 */
export interface RetrievalHit {
  readonly doc: RetrievalDoc;
  readonly score: number;
}

/**
 * @beta
 * 检索端口：对会话历史做全文/语义检索，使模型可跨长对话 recall，
 * 无需把全部历史塞进上下文。零依赖后端用 BM25（#M2，复用 #M1 检索内核）。
 */
export interface RetrievalPort {
  readonly name: string;
  /** 索引一条会话文档。 */
  index(doc: RetrievalDoc): void;
  /** 检索：自然语言查询 → 降序得分片段，可限定 sessionId。 */
  search(query: string, limit: number, sessionId?: string): readonly RetrievalHit[];
}
