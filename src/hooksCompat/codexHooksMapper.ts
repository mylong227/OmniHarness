import type { SessionEvent } from '../ports/runtime/event.js';
import type { HookEventEnvelope } from './formats.js';

/**
 * codex-claude hooks 事件格式映射。
 * 将内部 SessionEvent 归一化为 codex-claude hooks 约定的事件类型：
 *   user        → UserPromptSubmit
 *   assistant   → AgentMessage
 *   reasoning   → AgentReasoning
 *   tool_call   → ToolUse
 *   tool_result → ToolResult
 *   system      → SystemMessage
 */
export class CodexHooksMapper {
  /** 把一条内部事件映射为 codex-claude hooks 信封。 */
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

  /** 内部事件类型 → codex-claude hooks 外部类型。 */
  private externalType(event: SessionEvent): string {
    switch (event.type) {
      case 'user':
        return 'UserPromptSubmit';
      case 'assistant':
        return 'AgentMessage';
      case 'reasoning':
        return 'AgentReasoning';
      case 'tool_call':
        return 'ToolUse';
      case 'tool_result':
        return 'ToolResult';
      default:
        return 'SystemMessage';
    }
  }

  /** 载荷归一化：扁平为顶层字段，保证外部消费者可读。 */
  private normalize(event: SessionEvent): Record<string, unknown> {
    const p = event.payload as Record<string, unknown> | null | undefined;
    if (p !== null && typeof p === 'object') {
      return { ...p };
    }
    return { value: p };
  }
}
