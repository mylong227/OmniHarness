import type { RetrievalRole } from './retrievalRole.js';

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
