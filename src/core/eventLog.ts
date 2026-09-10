import type { SessionEvent } from '../ports/event.js';
import { EventFactory } from './eventFactory.js';

/** 追加型事件日志：只能追加，不可修改（模型所见即所记）。 */
export class AppendOnlyEventLog {
  private readonly events: SessionEvent[] = [];

  /** 追加一条事件并返回。 */
  public append(event: SessionEvent): SessionEvent {
    this.events.push(event);
    return event;
  }

  /** 追加一条用户事件。 */
  public appendUser(sessionId: string, content: string): SessionEvent {
    return this.append(EventFactory.user(sessionId, content));
  }

  /** 追加一条助手事件。 */
  public appendAssistant(sessionId: string, content: string): SessionEvent {
    return this.append(EventFactory.assistant(sessionId, content));
  }

  /** 追加一条推理事件。 */
  public appendReasoning(sessionId: string, content: string): SessionEvent {
    return this.append(EventFactory.reasoning(sessionId, content));
  }

  /** 追加一条工具调用事件。 */
  public appendToolCall(
    sessionId: string,
    callId: string,
    name: string,
    args: Record<string, unknown>,
  ): SessionEvent {
    return this.append(EventFactory.toolCall(sessionId, callId, name, args));
  }

  /** 追加一条工具结果事件。 */
  public appendToolResult(
    sessionId: string,
    callId: string,
    ok: boolean,
    output?: string,
    error?: string,
  ): SessionEvent {
    return this.append(EventFactory.toolResult(sessionId, callId, ok, output, error));
  }

  /** 注入历史事件（resume/fork 用，保持追加语义不破坏顺序）。 */
  public hydrate(events: readonly SessionEvent[]): void {
    this.events.push(...events);
  }

  /** 按类型过滤。 */
  public byType(type: string): SessionEvent[] {
    return this.events.filter((event) => event.type === type);
  }

  /** 全部事件（只读快照）。 */
  public all(): SessionEvent[] {
    return [...this.events];
  }

  /** 事件总数。 */
  public size(): number {
    return this.events.length;
  }

  /** 最新一条事件。 */
  public latest(): SessionEvent | undefined {
    return this.events.at(-1);
  }
}
