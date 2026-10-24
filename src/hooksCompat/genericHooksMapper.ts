import type { SessionEvent } from '../ports/runtime/event.ts';
import type { HookEventEnvelope } from './formats.ts';

/**
 * 通用 hooks 事件格式映射。
 * 将内部 SessionEvent 归一化为通用外部 hooks 约定的事件类型：
 *   user        → UserPromptSubmit
 *   assistant   → AgentMessage
 *   reasoning   → AgentReasoning
 *   tool_call   → ToolUse
 *   tool_result → ToolResult
 *   system      → SystemMessage
 */
export class GenericHooksMapper {
  /**
   * 把一条内部事件映射为通用 hooks 信封。
   * @param event 内部会话事件。
   * @param sequence 兼容层内的自增序号。
   * @returns 归一化后的外部信封。
   */
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

  /**
   * 内部事件类型 → 通用 hooks 外部类型。
   * @param event 内部会话事件。
   * @returns 外部事件类型名。
   */
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

  /**
   * 载荷归一化：扁平为顶层字段，保证外部消费者可读。
   * @param event 内部会话事件。
   * @returns 归一化后的载荷对象。
   */
  private normalize(event: SessionEvent): Record<string, unknown> {
    const p = event.payload as Record<string, unknown> | null | undefined;
    if (p !== null && typeof p === 'object') {
      return { ...p };
    }
    return { value: p };
  }
}
