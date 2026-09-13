import type { SessionEvent } from '../ports/runtime/event.js';

/**
 * 外部 hooks 事件信封（codex-claude / claude-code 通用最小字段）。
 * 兼容层将内部 SessionEvent 映射为这两种社区 hooks 约定的事件格式，
 * 供接入 codex-claude hooks / claude-code hooks 的外部消费者订阅。
 */
export interface HookEventEnvelope {
  /** 外部约定的事件类型（如 SessionStart / PreToolUse / tool_call ...）。 */
  readonly type: string;
  /** 事件序列号（兼容层内按到达顺序自增）。 */
  readonly sequence: number;
  /** 会话 ID。 */
  readonly sessionId: string;
  /** ISO 时间戳。 */
  readonly timestamp: string;
  /** 原始内部事件类型。 */
  readonly sourceType: SessionEvent['type'];
  /** 事件载荷（已按目标格式归一化）。 */
  readonly data: Record<string, unknown>;
}

/** 兼容层回调：消费者收到归一化后的外部 hook 事件。 */
export type HookConsumer = (envelope: HookEventEnvelope) => void;
