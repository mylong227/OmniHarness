/** 长期记忆事实的可变字段补丁（管理 UI 编辑时使用）。 */
export type MemoryFactPatch = Partial<{
  text: string;
  topic: string | undefined;
  importance: number;
  /** 失效时间（ISO，可选）：设为过去时间即可令该事实在 recall 中失效。 */
  expiresAt: string | undefined;
}>;

/** 一条持久化的长期记忆事实（跨会话留存，进程重启后仍可读回）。 */
export interface MemoryFact {
  /** 唯一 ID。 */
  readonly id: string;
  /** 事实文本（简短、可独立复用）。 */
  readonly text: string;
  /** 主题分类（可选，便于聚合）。 */
  readonly topic?: string;
  /** 重要度 1..5（5 最该留）。 */
  readonly importance: number;
  /** 创建时间（ISO）。 */
  readonly createdAt: string;
  /** 来源会话 ID。 */
  readonly sessionId: string;
  /** 来源：模型显式 `remember` 写入 / 回合末蒸馏 `consolidated` 沉淀。 */
  readonly source: 'tool' | 'consolidated';
  /** 失效时间（ISO，可选）：到点后 `recall` 不再召回该事实（fail-closed 丢弃，不自动删除）。 */
  readonly expiresAt?: string;
}

/**
 * 长期记忆端口：跨会话持久化的「durable fact」存储与召回。
 *
 * 与 #M2 `RetrievalPort`（内存会话检索，进程退出即丢）本质不同：
 * 这里存的是从对话中蒸馏出的、可跨会话复用的**持久事实**，落盘存活，
 * 使 harness 真正"记得"用户偏好、项目约定、关键决策、踩过的坑。
 */
export interface LongTermMemoryPort {
  readonly name: string;
  /** 写入一条持久事实。 */
  remember(fact: MemoryFact): void;
  /** 按自然语言召回 top-k 事实（BM25，跨全部会话）。 */
  recall(query: string, k: number): readonly MemoryFact[];
  /** 全部事实（导出/调试）。 */
  all(): readonly MemoryFact[];
  /** 事实总数。 */
  readonly count: number;
  /** 按 ID 取单条事实（管理 UI 编辑用）。 */
  get(id: string): MemoryFact | undefined;
  /** 编辑一条事实（管理 UI 用）；成功返回 true。 */
  update(id: string, patch: MemoryFactPatch): boolean;
  /** 删除一条事实（管理 UI 用）；成功返回 true。 */
  delete(id: string): boolean;
}
