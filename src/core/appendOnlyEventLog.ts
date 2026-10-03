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
   * 回卷到指定长度（**本类唯一允许的删减操作**，且只有一条合法调用链）。
   *
   * ## 为什么 append-only 的日志仍需要它
   *
   * 「只追加」约束的是**已记录事实不得就地篡改**（模型所见即所记），不是「历史不得撤销」。
   * `CheckpointManager.rollback` 是用户显式要求的**时间旅行**：把会话恢复到某个检查点。
   * 若只改磁盘而内存日志仍是全量，运行中会话的下一步 write-behind 落盘会把回滚**原样覆盖回去**
   * （2026-10-03 登记为 P1 缺陷：`CheckpointManager.rollback` 只改磁盘）。
   * 因此截断必须发生在**内存事实源**上，磁盘与检索索引随之对齐。
   *
   * ## 契约（fail-closed）
   *
   * - `size` 必须是 `[0, 当前长度]` 内的整数：越界或非整数一律抛错，**不静默夹取**——
   *   夹取会把「调用方算错了目标长度」伪装成成功回卷（用户以为回到了检查点 A，实际停在别处）。
   * - `size === 当前长度` 是合法空操作（返回 0）。
   * - 只能**向后**截断；不存在「恢复被截断事件」的接口（要恢复请重新 hydrate）。
   * @param size 截断后保留的事件条数（含第 0..size-1 条）。
   * @returns 被移除的事件条数。
   * @throws Error `size` 不是 `[0, 当前长度]` 内的整数时。
   */
  public rewindTo(size: number): number {
    if (!Number.isInteger(size) || size < 0 || size > this.events.length) {
      throw new Error(
        `事件日志回卷长度非法：${String(size)}（合法范围 0..${String(this.events.length)} 的整数）`,
      );
    }
    const removed = this.events.length - size;
    if (removed > 0) {
      this.events.length = size;
    }
    return removed;
  }

  /**
   * 被移除区间的全部事件（回卷前取出，供检索索引等派生态同步清理）。
   * @param size 回卷后保留的条数（语义同 {@link AppendOnlyEventLog.rewindTo}）。
   * @returns 将被移除的事件数组（`size >= 长度` 时为空的只读数组）。
   */
  public eventsFrom(size: number): readonly SessionEvent[] {
    return size >= this.events.length ? [] : this.events.slice(Math.max(0, size));
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
