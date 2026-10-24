import type { SessionEvent } from '../ports/runtime/event.ts';

/** AG-UI 事件类型（与 @ag-ui/core 的 EventType 字符串一一对应）。 */
export type AgUiEventType =
  | 'RUN_STARTED'
  | 'RUN_FINISHED'
  | 'RUN_ERROR'
  | 'STEP_STARTED'
  | 'STEP_FINISHED'
  | 'TEXT_MESSAGE_START'
  | 'TEXT_MESSAGE_CONTENT'
  | 'TEXT_MESSAGE_END'
  | 'TOOL_CALL_START'
  | 'TOOL_CALL_ARGS'
  | 'TOOL_CALL_END'
  | 'TOOL_CALL_RESULT'
  | 'STATE_SNAPSHOT'
  | 'STATE_DELTA'
  | 'MESSAGES_SNAPSHOT'
  | 'REASONING_MESSAGE_START'
  | 'REASONING_MESSAGE_CONTENT'
  | 'REASONING_MESSAGE_END'
  | 'RAW'
  | 'CUSTOM';

/** 所有事件的公共字段。 */
export interface AgUiBaseEvent {
  /** 事件类型（判别字段）。 */
  readonly type: AgUiEventType;
  /** 事件产生时间（毫秒时间戳）。 */
  readonly timestamp?: number;
  /** 原始事件（可选，透传用）。 */
  readonly rawEvent?: unknown;
}

/** RUN_STARTED：一次 agent run 开始。 */
export interface AgUiRunStartedEvent extends AgUiBaseEvent {
  /** 判别字段。 */
  readonly type: 'RUN_STARTED';
  /** 会话线程 id。 */
  readonly threadId: string;
  /** 本次 run id。 */
  readonly runId: string;
  /** 本次输入（可选）。 */
  readonly input?: unknown;
}

/** RUN_FINISHED：一次 run 正常结束。 */
export interface AgUiRunFinishedEvent extends AgUiBaseEvent {
  /** 判别字段。 */
  readonly type: 'RUN_FINISHED';
  /** 会话线程 id。 */
  readonly threadId: string;
  /** 本次 run id。 */
  readonly runId: string;
  /** 结果（finalText / steps 等）。 */
  readonly result?: unknown;
}

/** RUN_ERROR：一次 run 失败或被取消。 */
export interface AgUiRunErrorEvent extends AgUiBaseEvent {
  /** 判别字段。 */
  readonly type: 'RUN_ERROR';
  /** 可读错误信息。 */
  readonly message: string;
  /** 错误码（取消为 `CANCELLED`）。 */
  readonly code?: string;
}

/** TEXT_MESSAGE_START：助手文本消息开始。 */
export interface AgUiTextMessageStartEvent extends AgUiBaseEvent {
  /** 判别字段。 */
  readonly type: 'TEXT_MESSAGE_START';
  /** 消息 id。 */
  readonly messageId: string;
  /** 固定为 assistant。 */
  readonly role: 'assistant';
}

/** TEXT_MESSAGE_CONTENT：文本增量。 */
export interface AgUiTextMessageContentEvent extends AgUiBaseEvent {
  /** 判别字段。 */
  readonly type: 'TEXT_MESSAGE_CONTENT';
  /** 消息 id。 */
  readonly messageId: string;
  /** 文本增量（非空）。 */
  readonly delta: string;
}

/** TEXT_MESSAGE_END：文本消息结束。 */
export interface AgUiTextMessageEndEvent extends AgUiBaseEvent {
  /** 判别字段。 */
  readonly type: 'TEXT_MESSAGE_END';
  /** 消息 id。 */
  readonly messageId: string;
}

/** TOOL_CALL_START：工具调用开始。 */
export interface AgUiToolCallStartEvent extends AgUiBaseEvent {
  /** 判别字段。 */
  readonly type: 'TOOL_CALL_START';
  /** 工具调用 id。 */
  readonly toolCallId: string;
  /** 工具名。 */
  readonly toolCallName: string;
  /** 父消息 id（可选）。 */
  readonly parentMessageId?: string;
}

/** TOOL_CALL_ARGS：工具参数增量。 */
export interface AgUiToolCallArgsEvent extends AgUiBaseEvent {
  /** 判别字段。 */
  readonly type: 'TOOL_CALL_ARGS';
  /** 工具调用 id。 */
  readonly toolCallId: string;
  /** 参数 JSON 增量。 */
  readonly delta: string;
}

/** TOOL_CALL_END：工具调用结束。 */
export interface AgUiToolCallEndEvent extends AgUiBaseEvent {
  /** 判别字段。 */
  readonly type: 'TOOL_CALL_END';
  /** 工具调用 id。 */
  readonly toolCallId: string;
}

/** TOOL_CALL_RESULT：工具执行结果。 */
export interface AgUiToolCallResultEvent extends AgUiBaseEvent {
  /** 判别字段。 */
  readonly type: 'TOOL_CALL_RESULT';
  /** 结果消息 id。 */
  readonly messageId: string;
  /** 工具调用 id。 */
  readonly toolCallId: string;
  /** 结果文本。 */
  readonly content: string;
  /** 角色（固定 tool）。 */
  readonly role?: 'tool';
}

/** STATE_SNAPSHOT：完整状态快照（todos / plan）。 */
export interface AgUiStateSnapshotEvent extends AgUiBaseEvent {
  /** 判别字段。 */
  readonly type: 'STATE_SNAPSHOT';
  /** 状态快照。 */
  readonly snapshot: unknown;
}

/** STATE_DELTA：JSON Patch 增量（本适配层暂不产生，保留类型面）。 */
export interface AgUiStateDeltaEvent extends AgUiBaseEvent {
  /** 判别字段。 */
  readonly type: 'STATE_DELTA';
  /** RFC 6902 补丁。 */
  readonly delta: readonly unknown[];
}

/** MESSAGES_SNAPSHOT：全量消息快照（保留类型面）。 */
export interface AgUiMessagesSnapshotEvent extends AgUiBaseEvent {
  /** 判别字段。 */
  readonly type: 'MESSAGES_SNAPSHOT';
  /** 消息列表。 */
  readonly messages: readonly unknown[];
}

/** REASONING_MESSAGE_START：思考消息开始。 */
export interface AgUiReasoningStartEvent extends AgUiBaseEvent {
  /** 判别字段。 */
  readonly type: 'REASONING_MESSAGE_START';
  /** 消息 id。 */
  readonly messageId: string;
  /** 固定为 reasoning。 */
  readonly role: 'reasoning';
}

/** REASONING_MESSAGE_CONTENT：思考增量。 */
export interface AgUiReasoningContentEvent extends AgUiBaseEvent {
  /** 判别字段。 */
  readonly type: 'REASONING_MESSAGE_CONTENT';
  /** 消息 id。 */
  readonly messageId: string;
  /** 思考增量。 */
  readonly delta: string;
}

/** REASONING_MESSAGE_END：思考消息结束。 */
export interface AgUiReasoningEndEvent extends AgUiBaseEvent {
  /** 判别字段。 */
  readonly type: 'REASONING_MESSAGE_END';
  /** 消息 id。 */
  readonly messageId: string;
}

/** RAW：外部事件透传。 */
export interface AgUiRawEvent extends AgUiBaseEvent {
  /** 判别字段。 */
  readonly type: 'RAW';
  /** 原始事件。 */
  readonly event: unknown;
  /** 来源。 */
  readonly source?: string;
}

/** CUSTOM：应用自定义事件（question / turn_diff / usage 等）。 */
export interface AgUiCustomEvent extends AgUiBaseEvent {
  /** 判别字段。 */
  readonly type: 'CUSTOM';
  /** 自定义事件名。 */
  readonly name: string;
  /** 事件值。 */
  readonly value: unknown;
}

/** AG-UI 事件联合。 */
export type AgUiEvent =
  | AgUiRunStartedEvent
  | AgUiRunFinishedEvent
  | AgUiRunErrorEvent
  | AgUiTextMessageStartEvent
  | AgUiTextMessageContentEvent
  | AgUiTextMessageEndEvent
  | AgUiToolCallStartEvent
  | AgUiToolCallArgsEvent
  | AgUiToolCallEndEvent
  | AgUiToolCallResultEvent
  | AgUiStateSnapshotEvent
  | AgUiStateDeltaEvent
  | AgUiMessagesSnapshotEvent
  | AgUiReasoningStartEvent
  | AgUiReasoningContentEvent
  | AgUiReasoningEndEvent
  | AgUiRawEvent
  | AgUiCustomEvent;

/** 一次 AG-UI run 的输入（RunAgentInput 的最小子集）。 */
export interface AgUiRunInput {
  /** 会话线程 id（缺省由服务端生成）。 */
  readonly threadId?: string;
  /** 本次 run id（缺省由服务端生成）。 */
  readonly runId?: string;
  /** 历史消息（本适配层只透传，不解析）。 */
  readonly messages?: readonly unknown[];
  /** 前端状态。 */
  readonly state?: unknown;
  /** 透传参数。 */
  readonly forwardedProps?: unknown;
}

/** Agent 运行器：把一次 run 映射为 OmniHarness 会话事件流（可被 AbortSignal 中止）。 */
export type AgUiAgentRunner = (
  input: AgUiRunInput,
  signal: AbortSignal,
) => AsyncIterable<SessionEvent>;

/** AG-UI SSE 服务依赖。 */
export interface AgUiHttpServerOptions {
  /** 运行器（真实装配或测试替身）。 */
  readonly run: AgUiAgentRunner;
  /** 监听地址（缺省 127.0.0.1）。 */
  readonly host?: string;
  /** 请求体上限（字节，缺省 1 MiB）。 */
  readonly maxBodyBytes?: number;
}
