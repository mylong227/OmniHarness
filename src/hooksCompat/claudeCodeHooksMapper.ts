import type { SessionEvent } from '../ports/event.js';
import type { HookEventEnvelope } from './formats.js';

/**
 * claude-code hooks 事件格式映射。
 * 将内部 SessionEvent 归一化为 claude-code hooks 约定的事件类型：
 *   user        → UserPromptSubmit
 *   assistant   → AssistantMessage
 *   reasoning   → AgentReasoning
 *   tool_call   → PreToolUse
 *   tool_result → PostToolUse
 *   system      → Notification
 * 与 codex 映射不同处：claude-code 使用 Pre/PostToolUse 语义，且 PreToolUse
 * 需携带 tool_use_id 便于关联 PostToolUse。
 */
export class ClaudeCodeHooksMapper {
  /** 把一条内部事件映射为 claude-code hooks 信封。 */
  public map(event: SessionEvent, sequence: number): HookEventEnvelope {
    return {
      type: this.externalType(event),
      sequence,
      sessionId: event.sessionId,
      timestamp: event.timestamp,
      sourceType: event.type,
      data: this.normalize(event),
    };
  }

  /** 内部事件类型 → claude-code hooks 外部类型。 */
  private externalType(event: SessionEvent): string {
    switch (event.type) {
      case 'user':
        return 'UserPromptSubmit';
      case 'assistant':
        return 'AssistantMessage';
      case 'reasoning':
        return 'AgentReasoning';
      case 'tool_call':
        return 'PreToolUse';
      case 'tool_result':
        return 'PostToolUse';
      default:
        return 'Notification';
    }
  }

  /** 载荷归一化：扁平为顶层字段；tool 事件补 tool_use_id 关联。 */
  private normalize(event: SessionEvent): Record<string, unknown> {
    const p = event.payload as Record<string, unknown> | null | undefined;
    const base: Record<string, unknown> =
      p !== null && typeof p === 'object' ? { ...p } : { value: p };
    if (event.type === 'tool_call' && base['callId'] !== undefined) {
      base['tool_use_id'] = base['callId'];
    }
    return base;
  }
}
