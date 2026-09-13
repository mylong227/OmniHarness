/** 会话事件类型（append-only 日志的事件分类）。 */
export type EventType =
  | 'user'
  | 'assistant'
  | 'reasoning'
  | 'tool_call'
  | 'tool_result'
  | 'system'
  | 'todo'
  | 'plan'
  | 'question'
  /** 回合级变更（#M5）：本回合写类工具造成的 unified diff，回合结束时广播一次。 */
  | 'turn_diff'
  /** 模型调用用量（#S29 / live 跑分成本计量）：payload 为 { usage }。 */
  | 'model'
  /** 会话元数据（仅新会话首条）：payload 为 { workspace }，供按项目收纳/检索会话。不进模型上下文。 */
  | 'session_meta';

/** 会话事件：模型所见即所记的唯一事实源。 */
export interface SessionEvent {
  readonly id: string;
  readonly type: EventType;
  readonly sessionId: string;
  readonly timestamp: string;
  readonly payload: unknown;
}
