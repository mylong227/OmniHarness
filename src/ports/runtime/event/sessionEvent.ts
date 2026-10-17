import type { EventType } from './eventType.ts';

/** 会话事件：模型所见即所记的唯一事实源。 */
export interface SessionEvent {
  readonly id: string;
  readonly type: EventType;
  readonly sessionId: string;
  readonly timestamp: string;
  readonly payload: unknown;
}
