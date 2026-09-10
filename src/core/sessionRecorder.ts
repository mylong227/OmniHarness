import type { SessionEvent } from '../ports/event.js';
import type { EventPort } from '../ports/eventPort.js';
import type { RetrievalDoc, RetrievalPort, RetrievalRole } from '../ports/retrieval.js';
import type { ImageContent, FileAttachment, ModelUsage } from '../ports/model.js';
import { AppendOnlyEventLog } from './eventLog.js';
import { EventFactory } from './eventFactory.js';

/** 会话记录器：统一"写入日志 + 广播事件"，保证可观测性不遗漏。 */
export class SessionRecorder {
  private readonly sid: string;
  private seq = 0;
  /** 本回合起点在事件日志中的下标（#OBS-10）；0 = 未标记，等同全文起点。 */
  private turnStartIndex = 0;

  public constructor(
    private readonly log: AppendOnlyEventLog,
    private readonly events: EventPort,
    sessionId: string,
    /** 检索端口（#M2，可选）：记录事件时同步索引可检索文本，支持跨长对话 recall。 */
    private readonly retrieval?: RetrievalPort,
  ) {
    this.sid = sessionId;
  }

  /** 记录用户消息（images/files 可选，随首条用户消息送入模型，#B1/#B5）。 */
  public user(
    content: string,
    images?: readonly ImageContent[],
    files?: readonly FileAttachment[],
  ): SessionEvent {
    return this.record(EventFactory.user(this.sid, content, images, files));
  }

  /** 记录助手消息。 */
  public assistant(content: string, reasoning?: string): SessionEvent {
    return this.record(EventFactory.assistant(this.sid, content, reasoning));
  }

  /** 记录模型调用用量（#S29 / live 跑分成本计量）；modelName 用于按模型统计。 */
  public usage(usage: ModelUsage, modelName?: string): SessionEvent {
    return this.record(EventFactory.model(this.sid, usage, modelName));
  }

  /** 记录会话元数据（新会话首条：创建时的工作区，供按项目收纳）。 */
  public sessionMeta(workspace: string): SessionEvent {
    return this.record(EventFactory.sessionMeta(this.sid, workspace));
  }

  /** 记录推理轨迹。 */
  public reasoning(content: string): SessionEvent {
    return this.record(EventFactory.reasoning(this.sid, content));
  }

  /** 记录工具调用。 */
  public toolCall(callId: string, name: string, args: Record<string, unknown>): SessionEvent {
    return this.record(EventFactory.toolCall(this.sid, callId, name, args));
  }

  /** 记录系统说明（如上下文压缩点）。 */
  public system(content: string): SessionEvent {
    return this.record(EventFactory.system(this.sid, content));
  }

  /** 记录回合级变更（#M5）：本回合 unified diff，供 UI/审计查看改了什么。 */
  public turnDiff(diff: string): SessionEvent {
    return this.record(EventFactory.turnDiff(this.sid, diff));
  }

  /** 记录工具结果。 */
  public toolResult(callId: string, ok: boolean, output?: string, error?: string): SessionEvent {
    return this.record(EventFactory.toolResult(this.sid, callId, ok, output, error));
  }

  /**
   * 标记本回合起点（#OBS-10）：此后 `lastAssistantText()` 只认本回合产出的 assistant。
   *
   * 不标记的后果：resume/fork 会话的历史 assistant 事件混在同一条事件日志里，
   * 若本轮模型全程调工具或空输出而未产文本，`lastAssistantText()` 会取到**上一轮的
   * 历史答案**当作本轮 finalText——用户看到「上轮回答」被原样复读，且因 finalText
   * 非空，步数耗尽兜底也永不触发。这是比 hasText:false 更危险的静默错误答案。
   */
  public markTurnStart(): void {
    this.turnStartIndex = this.log.size();
  }

  /** 本回合内最新一条助手文本（不含历史回合；未标记起点时等价于全文最后一条）。 */
  public lastAssistantText(): string | undefined {
    const all = this.log.all();
    for (let i = all.length - 1; i >= this.turnStartIndex; i--) {
      const event = all[i]!;
      if (event.type === 'assistant') {
        return (event.payload as { content?: string }).content;
      }
    }
    return undefined;
  }

  /** 全部事件（上下文投影用）。 */
  public allEvents(): readonly SessionEvent[] {
    return this.log.all();
  }

  /** 会话 ID。 */
  public sessionId(): string {
    return this.sid;
  }

  /** 写入日志并广播。 */
  private record(event: SessionEvent): SessionEvent {
    this.log.append(event);
    this.events.emit(event);
    this.indexToRetrieval(event);
    return event;
  }

  /** 把可检索事件文本同步索引进检索端口（#M2）；reasoning/tool_call 等非内容事件跳过。 */
  private indexToRetrieval(event: SessionEvent): void {
    if (this.retrieval === undefined) {
      return;
    }
    const doc = docOf(event, this.seq);
    if (doc === undefined) {
      return;
    }
    this.seq += 1;
    this.retrieval.index(doc);
  }
}

/** 从会话事件抽取可检索文档（无法抽取则返回 undefined，不索引）。 */
function docOf(event: SessionEvent, seq: number): RetrievalDoc | undefined {
  const payload = event.payload as Record<string, unknown>;
  let role: RetrievalRole | undefined;
  let text: string | undefined;
  switch (event.type) {
    case 'user':
    case 'assistant':
    case 'system':
      role = event.type;
      text = typeof payload['content'] === 'string' ? (payload['content'] as string) : undefined;
      break;
    case 'tool_result':
      role = 'tool';
      text =
        typeof payload['output'] === 'string'
          ? (payload['output'] as string)
          : typeof payload['error'] === 'string'
            ? (payload['error'] as string)
            : undefined;
      break;
    default:
      // reasoning / tool_call / todo / plan / question / turn_diff 不进入检索索引。
      return undefined;
  }
  if (role === undefined || text === undefined || text.trim() === '') {
    return undefined;
  }
  return { id: event.id, sessionId: event.sessionId, seq, role, text, ts: event.timestamp };
}
