import type { SessionEvent } from '../ports/runtime/event.ts';
import type {
  AgUiEvent,
  AgUiReasoningContentEvent,
  AgUiReasoningEndEvent,
  AgUiReasoningStartEvent,
  AgUiRunErrorEvent,
  AgUiRunFinishedEvent,
  AgUiRunStartedEvent,
  AgUiTextMessageContentEvent,
  AgUiTextMessageEndEvent,
  AgUiTextMessageStartEvent,
  AgUiToolCallArgsEvent,
  AgUiToolCallEndEvent,
  AgUiToolCallResultEvent,
  AgUiToolCallStartEvent,
} from './aguiProtocol.ts';

/** 映射器构造参数。 */
export interface AgUiEventMapperOptions {
  /** 会话线程 id。 */
  readonly threadId: string;
  /** 本次 run id。 */
  readonly runId: string;
}

/**
 * OmniHarness 会话事件 → AG-UI 事件的映射器（单 run 实例）。
 *
 * 只做「事件翻译」：正文 → `TEXT_MESSAGE_*`，工具 → `TOOL_CALL_*`，计划/待办 → `STATE_SNAPSHOT`，
 * 其余（提问 / 回合 diff / 用量）→ `CUSTOM`。不解析前端状态，也不改现有 SSE/RPC。
 */
export class AgUiEventMapper {
  /** 会话线程 id。 */
  private readonly threadId: string;
  /** 本次 run id。 */
  private readonly runId: string;
  /** 当前状态快照（todos / plan）。 */
  private readonly state: Record<string, unknown> = {};
  /** 最近一条助手正文（RUN_FINISHED 的 result.finalText）。 */
  private lastText = '';
  /** 已映射的步数（助手消息 + 工具调用）。 */
  private steps = 0;

  /**
   * @param options 线程 / run 标识。
   */
  public constructor(options: AgUiEventMapperOptions) {
    this.threadId = options.threadId;
    this.runId = options.runId;
  }

  /**
   * RUN_STARTED 事件。
   * @param input 本次输入（可选）。
   * @returns RUN_STARTED。
   */
  public runStarted(input?: unknown): AgUiRunStartedEvent {
    return {
      type: 'RUN_STARTED',
      threadId: this.threadId,
      runId: this.runId,
      timestamp: Date.now(),
      ...(input !== undefined ? { input } : {}),
    };
  }

  /**
   * RUN_FINISHED 事件（带最终文本与步数）。
   * @returns RUN_FINISHED。
   */
  public runFinished(): AgUiRunFinishedEvent {
    return {
      type: 'RUN_FINISHED',
      threadId: this.threadId,
      runId: this.runId,
      timestamp: Date.now(),
      result: { finalText: this.lastText, steps: this.steps },
    };
  }

  /**
   * RUN_ERROR 事件。
   * @param message 可读错误。
   * @param code 错误码（取消为 `CANCELLED`）。
   * @returns RUN_ERROR。
   */
  public runError(message: string, code?: string): AgUiRunErrorEvent {
    return {
      type: 'RUN_ERROR',
      message,
      timestamp: Date.now(),
      ...(code !== undefined ? { code } : {}),
    };
  }

  /**
   * 把一条会话事件映射为 0..N 条 AG-UI 事件。
   * @param event 会话事件。
   * @returns AG-UI 事件序列。
   */
  public map(event: SessionEvent): readonly AgUiEvent[] {
    const payload = AgUiEventMapper.payloadOf(event);
    switch (event.type) {
      case 'assistant':
        return this.assistantEvents(event, payload);
      case 'reasoning':
        return this.reasoningEvents(event, payload);
      case 'tool_call':
        return this.toolCallEvents(payload);
      case 'tool_result':
        return this.toolResultEvents(payload);
      case 'todo':
        return this.stateEvents('todos', payload['todos']);
      case 'plan':
        return this.stateEvents('plan', payload);
      case 'question':
        return [this.custom('question', payload)];
      case 'turn_diff':
        return [this.custom('turn_diff', payload)];
      case 'model':
        return [this.custom('usage', payload['usage'])];
      default:
        return [];
    }
  }

  /**
   * assistant 事件：思考链 → REASONING_*，正文 → TEXT_MESSAGE_*。
   * @param event 源事件。
   * @param payload 事件负载。
   * @returns AG-UI 事件序列。
   */
  private assistantEvents(
    event: SessionEvent,
    payload: Record<string, unknown>,
  ): readonly AgUiEvent[] {
    const out: AgUiEvent[] = [];
    this.steps += 1;
    const reasoning = AgUiEventMapper.textOf(payload, 'reasoning');
    if (reasoning !== '') out.push(...this.reasoningUpdate(`${event.id}-thought`, reasoning));
    const content = AgUiEventMapper.textOf(payload, 'content');
    if (content !== '') {
      this.lastText = content;
      out.push(...AgUiEventMapper.textUpdate(event.id, content));
    }
    return out;
  }

  /**
   * reasoning 事件 → REASONING_*。
   * @param event 源事件。
   * @param payload 事件负载。
   * @returns AG-UI 事件序列。
   */
  private reasoningEvents(
    event: SessionEvent,
    payload: Record<string, unknown>,
  ): readonly AgUiEvent[] {
    const content = AgUiEventMapper.textOf(payload, 'content');
    return content === '' ? [] : this.reasoningUpdate(event.id, content);
  }

  /**
   * tool_call 事件 → TOOL_CALL_START / ARGS / END。
   * @param payload 事件负载（callId / name / args）。
   * @returns AG-UI 事件序列。
   */
  private toolCallEvents(payload: Record<string, unknown>): readonly AgUiEvent[] {
    const toolCallId = AgUiEventMapper.textOf(payload, 'callId');
    if (toolCallId === '') return [];
    this.steps += 1;
    const name = AgUiEventMapper.textOf(payload, 'name');
    const args = AgUiEventMapper.jsonOf(payload['args']);
    return [
      { type: 'TOOL_CALL_START', toolCallId, toolCallName: name, timestamp: Date.now() },
      { type: 'TOOL_CALL_ARGS', toolCallId, delta: args, timestamp: Date.now() },
      { type: 'TOOL_CALL_END', toolCallId, timestamp: Date.now() },
    ];
  }

  /**
   * tool_result 事件 → TOOL_CALL_RESULT。
   * @param payload 事件负载（callId / ok / output / error）。
   * @returns AG-UI 事件序列。
   */
  private toolResultEvents(payload: Record<string, unknown>): readonly AgUiEvent[] {
    const toolCallId = AgUiEventMapper.textOf(payload, 'callId');
    if (toolCallId === '') return [];
    const ok = payload['ok'] === true;
    const text = ok
      ? AgUiEventMapper.textOf(payload, 'output')
      : AgUiEventMapper.textOf(payload, 'error');
    return [
      {
        type: 'TOOL_CALL_RESULT',
        messageId: `tool-${toolCallId}`,
        toolCallId,
        content: text === '' ? (ok ? '(无输出)' : '工具执行失败') : text,
        role: 'tool',
        timestamp: Date.now(),
      },
    ];
  }

  /**
   * 计划/待办 → STATE_SNAPSHOT（状态对象累积后整份下发）。
   * @param key 状态键（todos / plan）。
   * @param value 状态值。
   * @returns AG-UI 事件序列。
   */
  private stateEvents(key: string, value: unknown): readonly AgUiEvent[] {
    this.state[key] = value;
    return [
      {
        type: 'STATE_SNAPSHOT',
        snapshot: { ...this.state },
        timestamp: Date.now(),
      },
    ];
  }

  /**
   * 构造文本消息三元组。
   * @param messageId 消息 id。
   * @param text 文本内容。
   * @returns START / CONTENT / END。
   */
  private static textUpdate(messageId: string, text: string): readonly AgUiEvent[] {
    const start: AgUiTextMessageStartEvent = {
      type: 'TEXT_MESSAGE_START',
      messageId,
      role: 'assistant',
      timestamp: Date.now(),
    };
    const content: AgUiTextMessageContentEvent = {
      type: 'TEXT_MESSAGE_CONTENT',
      messageId,
      delta: text,
      timestamp: Date.now(),
    };
    const end: AgUiTextMessageEndEvent = {
      type: 'TEXT_MESSAGE_END',
      messageId,
      timestamp: Date.now(),
    };
    return [start, content, end];
  }

  /**
   * 构造思考消息三元组。
   * @param messageId 消息 id。
   * @param text 思考内容。
   * @returns REASONING_MESSAGE_START / CONTENT / END。
   */
  private reasoningUpdate(messageId: string, text: string): readonly AgUiEvent[] {
    const start: AgUiReasoningStartEvent = {
      type: 'REASONING_MESSAGE_START',
      messageId,
      role: 'reasoning',
      timestamp: Date.now(),
    };
    const content: AgUiReasoningContentEvent = {
      type: 'REASONING_MESSAGE_CONTENT',
      messageId,
      delta: text,
      timestamp: Date.now(),
    };
    const end: AgUiReasoningEndEvent = {
      type: 'REASONING_MESSAGE_END',
      messageId,
      timestamp: Date.now(),
    };
    return [start, content, end];
  }

  /**
   * 构造自定义事件。
   * @param name 事件名。
   * @param value 事件值。
   * @returns CUSTOM。
   */
  private custom(name: string, value: unknown): AgUiEvent {
    return { type: 'CUSTOM', name, value, timestamp: Date.now() };
  }

  /**
   * 事件负载归一为普通对象。
   * @param event 会话事件。
   * @returns 负载对象。
   */
  private static payloadOf(event: SessionEvent): Record<string, unknown> {
    return typeof event.payload === 'object' && event.payload !== null
      ? (event.payload as Record<string, unknown>)
      : {};
  }

  /**
   * 取字符串字段。
   * @param record 记录。
   * @param key 字段名。
   * @returns 文本（非字符串为空串）。
   */
  private static textOf(record: Record<string, unknown>, key: string): string {
    const value = record[key];
    return typeof value === 'string' ? value : '';
  }

  /**
   * JSON 序列化（失败回落 `{}`，绝不因循环引用打断整条事件流）。
   * @param value 待序列化值。
   * @returns JSON 文本。
   */
  private static jsonOf(value: unknown): string {
    try {
      return JSON.stringify(value ?? {});
    } catch {
      return '{}';
    }
  }
}

/** 供测试与调用方断言工具结果事件形状。 */
export type {
  AgUiToolCallResultEvent,
  AgUiToolCallStartEvent,
  AgUiToolCallArgsEvent,
  AgUiToolCallEndEvent,
};
