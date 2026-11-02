import type { EventType } from './eventType.ts';

/** 会话事件：模型所见即所记的唯一事实源。 */
export interface SessionEvent {
  readonly id: string;
  readonly type: EventType;
  readonly sessionId: string;
  readonly timestamp: string;
  /**
   * 会话内单调递增序号（2026-10-21 加）：SSE 断线重连的 `Last-Event-ID` 与事件对账
   * 都靠它。旧存档没有该字段 ⇒ 读取侧必须容忍 undefined（新事件由 SessionRecorder 编号）。
   */
  readonly seq?: number;
  readonly payload: unknown;
}
