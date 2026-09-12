import type { SessionEvent } from './event.js';
import type { ImageContent, FileAttachment, ModelContextSnapshot, ModelUsage } from './model.js';

/**
 * 事件工厂端口（P1 解耦）。
 *
 * 原 `EventFactory`（core）被多个 adapter 直接 import 单例，构成 adapters→core 违规。
 * 抽出端口后，adapter 只依赖此接口（不引 core 类型/实现），实例由组合根
 * （config 层，享有装配特权）注入。core 的 `EventFactory` 实现本接口。
 */

/** `todo_write` 触发的待办快照条目。 */
export interface TodoSnapshotEntry {
  readonly content: string;
  readonly status: string;
}

/** 事件工厂端口：统一构造各类会话事件。 */
export interface EventFactoryPort {
  /** 用户事件（可含多模态输入）。 */
  user(
    sessionId: string,
    content: string,
    images?: readonly ImageContent[],
    files?: readonly FileAttachment[],
  ): SessionEvent;
  /** 助手事件（reasoning 可选）。 */
  assistant(sessionId: string, content: string, reasoning?: string): SessionEvent;
  /** 推理事件。 */
  reasoning(sessionId: string, content: string): SessionEvent;
  /** 工具调用事件。 */
  toolCall(
    sessionId: string,
    callId: string,
    name: string,
    args: Record<string, unknown>,
  ): SessionEvent;
  /** 工具结果事件。 */
  toolResult(
    sessionId: string,
    callId: string,
    ok: boolean,
    output?: string,
    error?: string,
  ): SessionEvent;
  /** 系统事件。 */
  system(sessionId: string, content: string): SessionEvent;
  /** 待办快照事件。 */
  todo(sessionId: string, todos: readonly TodoSnapshotEntry[]): SessionEvent;
  /** 计划态事件。 */
  plan(sessionId: string, plan: unknown): SessionEvent;
  /** 提问事件。 */
  question(sessionId: string, questions: unknown): SessionEvent;
  /** 回合级变更事件。 */
  turnDiff(sessionId: string, diff: string): SessionEvent;
  /** 模型用量事件。 */
  model(
    sessionId: string,
    usage: ModelUsage,
    modelName?: string,
    context?: ModelContextSnapshot,
  ): SessionEvent;
  /** 会话元数据事件。 */
  sessionMeta(sessionId: string, workspace: string): SessionEvent;
}
