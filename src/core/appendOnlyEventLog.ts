import type { SessionEvent } from '../ports/runtime/event.js';
import type { FileAttachment } from '../ports/model/model.js';
import { eventFactory } from './eventFactory.js';

/** 追加型事件日志：只能追加，不可修改（模型所见即所记）。 */
export class AppendOnlyEventLog {
  /** 会话事件的唯一事实存储（内存态），仅经 append/hydrate 追加。 */
  private readonly events: SessionEvent[] = [];

  /**
   * 追加一条事件并返回。
   * @param event 要追加的会话事件。
   * @returns 原样返回该事件（便于调用点链式写回）。
   */
  public append(event: SessionEvent): SessionEvent {
    this.events.push(event);
    return event;
  }

  /**
   * 追加一条用户事件。
   * @param sessionId 事件归属的会话 ID。
   * @param content 用户消息文本。
   * @returns 构造并追加后的 user 事件。
   */
  public appendUser(sessionId: string, content: string): SessionEvent {
    return this.append(eventFactory.user(sessionId, content));
  }

  /**
   * 追加一条助手事件。
   * @param sessionId 事件归属的会话 ID。
   * @param content 助手回复文本。
   * @returns 构造并追加后的 assistant 事件。
   */
  public appendAssistant(sessionId: string, content: string): SessionEvent {
    return this.append(eventFactory.assistant(sessionId, content));
  }

  /**
   * 追加一条推理事件。
   * @param sessionId 事件归属的会话 ID。
   * @param content 推理/思考过程文本。
   * @returns 构造并追加后的 reasoning 事件。
   */
  public appendReasoning(sessionId: string, content: string): SessionEvent {
    return this.append(eventFactory.reasoning(sessionId, content));
  }

  /**
   * 追加一条工具调用事件。
   * @param sessionId 事件归属的会话 ID。
   * @param callId 调用 ID（与 tool_result 配对）。
   * @param name 被调用工具名。
   * @param args 工具入参（原始 JSON 对象）。
   * @returns 构造并追加后的 tool_call 事件。
   */
  public appendToolCall(
    sessionId: string,
    callId: string,
    name: string,
    args: Record<string, unknown>,
  ): SessionEvent {
    return this.append(eventFactory.toolCall(sessionId, callId, name, args));
  }

  /**
   * 追加一条工具结果事件。
   * @param sessionId 事件归属的会话 ID。
   * @param callId 对应 tool_call 的调用 ID（配对键）。
   * @param ok 工具是否执行成功。
   * @param output 成功时的输出文本（可选）。
   * @param error 失败时的错误文本（可选）。
   * @param files 工具产出的文件附件（可选，P2-⑬）。
   * @returns 构造并追加后的 tool_result 事件。
   */
  public appendToolResult(
    sessionId: string,
    callId: string,
    ok: boolean,
    output?: string,
    error?: string,
    files?: readonly FileAttachment[],
  ): SessionEvent {
    return this.append(eventFactory.toolResult(sessionId, callId, ok, output, error, files));
  }

  /**
   * 注入历史事件（resume/fork 用，保持追加语义不破坏顺序）。
   * @param events 历史会话事件序列，按原顺序批量追加。
   
 * @returns 无返回值。
*/
  public hydrate(events: readonly SessionEvent[]): void {
    this.events.push(...events);
  }

  /**
   * 按类型过滤。
   * @param type 事件类型名（如 'assistant'、'tool_call'）。
   * @returns 该类型的全部事件（保持追加顺序）。
   */
  public byType(type: string): SessionEvent[] {
    return this.events.filter((event) => event.type === type);
  }

  /**
   * 全部事件（只读快照）。
   * @returns 当前日志的浅拷贝数组（外部改动不影响内部状态）。
   */
  public all(): SessionEvent[] {
    return [...this.events];
  }

  /**
   * 事件总数。
   * @returns 日志内事件条数（含 hydrate 注入的历史）。
   */
  public size(): number {
    return this.events.length;
  }

  /**
   * 最新一条事件。
   * @returns 最后追加的事件；空日志时为 undefined。
   */
  public latest(): SessionEvent | undefined {
    return this.events.at(-1);
  }
}
