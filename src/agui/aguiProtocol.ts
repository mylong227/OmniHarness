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
  | 'ACTIVITY_SNAPSHOT'
  | 'ACTIVITY_DELTA'
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

/** STEP_STARTED：run 内一个步骤开始（可选事件，本适配层暂不主动产生）。 */
export interface AgUiStepStartedEvent extends AgUiBaseEvent {
  /** 判别字段。 */
  readonly type: 'STEP_STARTED';
  /** 步骤名（与对应 STEP_FINISHED 配对）。 */
  readonly stepName: string;
}

/** STEP_FINISHED：run 内一个步骤结束（可选事件，本适配层暂不主动产生）。 */
export interface AgUiStepFinishedEvent extends AgUiBaseEvent {
  /** 判别字段。 */
  readonly type: 'STEP_FINISHED';
  /** 步骤名（与对应 STEP_STARTED 相同）。 */
  readonly stepName: string;
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

/** RFC 6902 `add` 操作：在 path 处插入 value。 */
export interface AgUiJsonPatchAddOperation {
  /** 操作码。 */
  readonly op: 'add';
  /** RFC 6901 JSON Pointer。 */
  readonly path: string;
  /** 插入值。 */
  readonly value: unknown;
}

/** RFC 6902 `remove` 操作：删除 path 处的值。 */
export interface AgUiJsonPatchRemoveOperation {
  /** 操作码。 */
  readonly op: 'remove';
  /** RFC 6901 JSON Pointer。 */
  readonly path: string;
}

/** RFC 6902 `replace` 操作：用 value 替换 path 处的值。 */
export interface AgUiJsonPatchReplaceOperation {
  /** 操作码。 */
  readonly op: 'replace';
  /** RFC 6901 JSON Pointer。 */
  readonly path: string;
  /** 替换值。 */
  readonly value: unknown;
}

/** RFC 6902 `move` 操作（类型面保留；映射器不产生）。 */
export interface AgUiJsonPatchMoveOperation {
  /** 操作码。 */
  readonly op: 'move';
  /** 源 JSON Pointer。 */
  readonly from: string;
  /** 目标 JSON Pointer。 */
  readonly path: string;
}

/** RFC 6902 `copy` 操作（类型面保留；映射器不产生）。 */
export interface AgUiJsonPatchCopyOperation {
  /** 操作码。 */
  readonly op: 'copy';
  /** 源 JSON Pointer。 */
  readonly from: string;
  /** 目标 JSON Pointer。 */
  readonly path: string;
}

/** RFC 6902 `test` 操作（类型面保留；映射器不产生）。 */
export interface AgUiJsonPatchTestOperation {
  /** 操作码。 */
  readonly op: 'test';
  /** RFC 6901 JSON Pointer。 */
  readonly path: string;
  /** 期望值。 */
  readonly value: unknown;
}

/**
 * RFC 6902 JSON Patch 操作联合。
 *
 * 映射器只生成 `add` / `replace` / `remove`（状态以对象键为粒度做增量；
 * 数组整体替换），其余三种保留完整类型面供调用方构造自定义补丁。
 */
export type AgUiJsonPatchOperation =
  | AgUiJsonPatchAddOperation
  | AgUiJsonPatchRemoveOperation
  | AgUiJsonPatchReplaceOperation
  | AgUiJsonPatchMoveOperation
  | AgUiJsonPatchCopyOperation
  | AgUiJsonPatchTestOperation;

/** STATE_SNAPSHOT：完整状态快照（todos / plan）。 */
export interface AgUiStateSnapshotEvent extends AgUiBaseEvent {
  /** 判别字段。 */
  readonly type: 'STATE_SNAPSHOT';
  /** 状态快照（前端应以整份替换本地状态）。 */
  readonly snapshot: unknown;
}

/** STATE_DELTA：JSON Patch 增量（首个状态用快照，后续变化用补丁）。 */
export interface AgUiStateDeltaEvent extends AgUiBaseEvent {
  /** 判别字段。 */
  readonly type: 'STATE_DELTA';
  /** RFC 6902 补丁（非空；无状态变化时不发事件）。 */
  readonly delta: readonly AgUiJsonPatchOperation[];
}

/** MESSAGES_SNAPSHOT：run 开始/恢复时的全量消息快照（无历史则不发）。 */
export interface AgUiMessagesSnapshotEvent extends AgUiBaseEvent {
  /** 判别字段。 */
  readonly type: 'MESSAGES_SNAPSHOT';
  /** 消息列表（AG-UI Message 对象，原样透传）。 */
  readonly messages: readonly unknown[];
}

/** ACTIVITY_SNAPSHOT：结构化活动（工具执行 / 子代理）的完整快照。 */
export interface AgUiActivitySnapshotEvent extends AgUiBaseEvent {
  /** 判别字段。 */
  readonly type: 'ACTIVITY_SNAPSHOT';
  /** 活动消息 id（与文本/思考消息 id 空间互斥）。 */
  readonly messageId: string;
  /** 活动类型（本适配层使用 `TOOL_CALL` / `SUBAGENT`）。 */
  readonly activityType: string;
  /** 活动内容对象（status / toolCallId / name 等）。 */
  readonly content: Readonly<Record<string, unknown>>;
  /** 是否替换同 id 的既有活动（缺省 true，符合 AG-UI 语义）。 */
  readonly replace?: boolean;
}

/** ACTIVITY_DELTA：对既有活动应用 JSON Patch 增量。 */
export interface AgUiActivityDeltaEvent extends AgUiBaseEvent {
  /** 判别字段。 */
  readonly type: 'ACTIVITY_DELTA';
  /** 目标活动消息 id（与对应快照一致）。 */
  readonly messageId: string;
  /** 活动类型（与最近一次快照一致）。 */
  readonly activityType: string;
  /** RFC 6902 补丁（应用到活动 content 上）。 */
  readonly patch: readonly AgUiJsonPatchOperation[];
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
  | AgUiStepStartedEvent
  | AgUiStepFinishedEvent
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
  | AgUiActivitySnapshotEvent
  | AgUiActivityDeltaEvent
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
  /**
   * 历史消息（AG-UI Message 对象）。
   *
   * 非空时作为 `MESSAGES_SNAPSHOT` 在 run 开始时首发（恢复/续跑同样适用）；
   * 空数组或未提供则**不发**该事件（不伪造空快照）。
   */
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
  /** 监听地址（缺省 127.0.0.1；非回环绑定必须配令牌，否则拒绝启动）。 */
  readonly host?: string;
  /** 请求体上限（字节，缺省 1 MiB）。 */
  readonly maxBodyBytes?: number;
  /**
   * Bearer 令牌（2026-10-27 审计收口）：非空时除探活外一律要求鉴权。
   * 缺省回落 `OMNI_SERVE_TOKEN` 环境变量（与主 serve 共用一把钥匙）。
   */
  readonly token?: string;
}
