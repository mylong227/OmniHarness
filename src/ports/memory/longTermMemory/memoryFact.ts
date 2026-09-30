/** 一条持久化的长期记忆事实（跨会话留存，进程重启后仍可读回）。 */
export interface MemoryFact {
  /** 唯一 ID。 */
  readonly id: string;
  /** 事实文本（简短、可独立复用）。 */
  readonly text: string;
  /** 主题分类（可选，便于聚合）。 */
  readonly topic?: string | undefined;
  /** 重要度 1..5（5 最该留）。 */
  readonly importance: number;
  /** 创建时间（ISO）。 */
  readonly createdAt: string;
  /** 来源会话 ID。 */
  readonly sessionId: string;
  /** 来源：模型显式 `remember` 写入 / 回合末蒸馏 `consolidated` 沉淀。 */
  readonly source: 'tool' | 'consolidated';
  /** 失效时间（ISO，可选）：到点后 `recall` 不再召回该事实（fail-closed 丢弃，不自动删除）。 */
  readonly expiresAt?: string | undefined;
}
