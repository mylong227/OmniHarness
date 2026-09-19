import type { SessionEvent } from '../ports/runtime/event.js';
import type { EventPort } from '../ports/runtime/eventPort.js';
import type {
  RetrievalDoc,
  RetrievalPort,
  RetrievalRole,
} from '../ports/intelligence/retrieval.js';
import type {
  ImageContent,
  FileAttachment,
  ModelContextSnapshot,
  ModelUsage,
} from '../ports/model/model.js';
import { AppendOnlyEventLog } from './appendOnlyEventLog.js';
import { eventFactory } from './eventFactory.js';
import { at } from '../util/arrayAt.js';

/** 会话记录器：统一"写入日志 + 广播事件"，保证可观测性不遗漏。 */
export class SessionRecorder {
  /** 本会话的事件流 ID：所有产出事件共享，保证事件归属一致。 */
  private readonly sid: string;
  /** 已索引进检索端口的事件序号（仅内容事件递增，保证检索文档 seq 单调）。 */
  private seq = 0;
  /** 本回合起点在事件日志中的下标（#OBS-10）；0 = 未标记，等同全文起点。 */
  private turnStartIndex = 0;

  public constructor(
    /** 追加式事件日志：本会话事实（source of truth），record 先写日志再广播。 */
    private readonly log: AppendOnlyEventLog,
    /** 事件广播端口：每条事件同步推给 UI/订阅方，是可观测性出口。 */
    private readonly events: EventPort,
    /** 会话 ID：构造期一次性绑定到 sid。 */
    sessionId: string,
    /** 检索端口（#M2，可选）：记录事件时同步索引可检索文本，支持跨长对话 recall。 */
    private readonly retrieval?: RetrievalPort,
  ) {
    this.sid = sessionId;
  }

  /**
   * 记录用户消息（images/files 可选，随首条用户消息送入模型，#B1/#B5）。
   * @param content 用户消息文本，进入事件流并投影进模型上下文。
   * @param images 可选图片内容数组，与文本同条消息送入模型。
   * @param files 可选文件附件数组，与文本同条消息送入模型。
   * @returns 落盘并广播后的 user 事件。
   */
  public user(
    content: string,
    images?: readonly ImageContent[],
    files?: readonly FileAttachment[],
  ): SessionEvent {
    return this.record(eventFactory.user(this.sid, content, images, files));
  }

  /**
   * 记录助手消息。
   * @param content 助手回复文本（模型最终输出）。
   * @param reasoning 可选思考过程文本，与回复一并落事件流。
   * @returns 落盘并广播后的 assistant 事件。
   */
  public assistant(content: string, reasoning?: string): SessionEvent {
    return this.record(eventFactory.assistant(this.sid, content, reasoning));
  }

  /**
   * 记录模型调用用量（#S29 / live 跑分成本计量）；modelName 用于按模型统计。
   * context 可选：本次请求的上下文占用快照（实测），供 UI 容量面板免重算读取。
   * @param usage 本次模型调用的 token 用量与成本计量。
   * @param modelName 产生该用量的模型名（路由/多模型时区分归属）。
   * @param context 可选的上下文占用快照（输入 token 实测口径）。
   * @returns 落盘并广播后的 model 事件。
   */
  public usage(
    usage: ModelUsage,
    modelName?: string,
    context?: ModelContextSnapshot,
  ): SessionEvent {
    return this.record(eventFactory.model(this.sid, usage, modelName, context));
  }

  /**
   * 记录会话元数据（新会话首条：创建时的工作区，供按项目收纳）。
   * @param workspace 创建会话时的工作区根目录。
   * @returns 落盘并广播后的 session_meta 事件。
   */
  public sessionMeta(workspace: string): SessionEvent {
    return this.record(eventFactory.sessionMeta(this.sid, workspace));
  }

  /**
   * 记录推理轨迹。
   * @param content 模型思考/推理过程文本。
   * @returns 落盘并广播后的 reasoning 事件。
   */
  public reasoning(content: string): SessionEvent {
    return this.record(eventFactory.reasoning(this.sid, content));
  }

  /**
   * 记录工具调用。
   * @param callId 调用 ID，与后续 tool_result 事件配对。
   * @param name 被调用工具名。
   * @param args 工具入参（原始 JSON 对象）。
   * @returns 落盘并广播后的 tool_call 事件。
   */
  public toolCall(callId: string, name: string, args: Record<string, unknown>): SessionEvent {
    return this.record(eventFactory.toolCall(this.sid, callId, name, args));
  }

  /**
   * 记录系统说明（如上下文压缩点）。
   * @param content 系统说明文本，作为 system 事件投影进模型上下文。
   * @returns 落盘并广播后的 system 事件。
   */
  public system(content: string): SessionEvent {
    return this.record(eventFactory.system(this.sid, content));
  }

  /**
   * 记录回合级变更（#M5）：本回合 unified diff，供 UI/审计查看改了什么。
   * @param diff 本回合累积的 unified diff 文本。
   * @returns 落盘并广播后的 turn_diff 事件。
   */
  public turnDiff(diff: string): SessionEvent {
    return this.record(eventFactory.turnDiff(this.sid, diff));
  }

  /**
   * 记录工具结果。
   * @param callId 对应 tool_call 的调用 ID（配对键）。
   * @param ok 工具是否执行成功。
   * @param output 成功时的输出文本（可选）。
   * @param error 失败时的错误文本（可选）。
   * @param files 工具产出的文件附件（可选，P2-⑬：`view_image` 把图片交给模型）。
   * @returns 落盘并广播后的 tool_result 事件。
   */
  public toolResult(
    callId: string,
    ok: boolean,
    output?: string,
    error?: string,
    files?: readonly FileAttachment[],
  ): SessionEvent {
    return this.record(eventFactory.toolResult(this.sid, callId, ok, output, error, files));
  }

  /**
   * 标记本回合起点（#OBS-10）：此后 `lastAssistantText()` 只认本回合产出的 assistant。
   *
   * 不标记的后果：resume/fork 会话的历史 assistant 事件混在同一条事件日志里，
   * 若本轮模型全程调工具或空输出而未产文本，`lastAssistantText()` 会取到**上一轮的
   * 历史答案**当作本轮 finalText——用户看到「上轮回答」被原样复读，且因 finalText
   * 非空，步数耗尽兜底也永不触发。这是比 hasText:false 更危险的静默错误答案。
   
 * @returns 无返回值。
*/
  public markTurnStart(): void {
    this.turnStartIndex = this.log.size();
  }

  /**
   * 本回合内最新一条助手文本（不含历史回合；未标记起点时等价于全文最后一条）。
   * @returns 本回合最后一条 assistant 事件的文本；本回合无助手文本时为 undefined。
   */
  public lastAssistantText(): string | undefined {
    const all = this.log.all();
    for (let i = all.length - 1; i >= this.turnStartIndex; i--) {
      const event = at(all, i);
      if (event.type === 'assistant') {
        return (event.payload as { content?: string }).content;
      }
    }
    return undefined;
  }

  /**
   * 全部事件（上下文投影用）。
   * @returns 事件日志当前全量快照（按追加顺序）。
   */
  public allEvents(): readonly SessionEvent[] {
    return this.log.all();
  }

  /**
   * 会话 ID。
   * @returns 本记录器绑定的会话 ID。
   */
  public sessionId(): string {
    return this.sid;
  }

  /**
   * 写入日志并广播。
   * @param event 待记录的会话事件（通常由 eventFactory 构造）。
   * @returns 原样返回该事件（append → emit → 索引 三步完成后）。
   */
  private record(event: SessionEvent): SessionEvent {
    this.log.append(event);
    this.events.emit(event);
    this.indexToRetrieval(event);
    return event;
  }

  /**
   * 把可检索事件文本同步索引进检索端口（#M2）；reasoning/tool_call 等非内容事件跳过。
   * @param event 刚落盘的事件，尝试抽取可检索文本建索引。
   
 * @returns 无返回值。
*/
  private indexToRetrieval(event: SessionEvent): void {
    if (this.retrieval === undefined) {
      return;
    }
    const doc = SessionRecorder.docOf(event, this.seq);
    if (doc === undefined) {
      return;
    }
    this.seq += 1;
    this.retrieval.index(doc);
  }

  /**
   * docOf — module-level helper moved into SessionRecorder.
   * @param {SessionEvent} event - event
   * @param {number} seq - seq
   * @returns {RetrievalDoc | undefined} - result
   */
  private static docOf(event: SessionEvent, seq: number): RetrievalDoc | undefined {
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
}

/**
 * 从会话事件抽取可检索文档（无法抽取则返回 undefined，不索引）。
 * @param event 源会话事件，user/assistant/system/tool_result 可抽取。
 * @param seq 检索文档序号（仅内容事件递增，保证召回顺序稳定）。
 * @returns 构造好的可检索文档；非内容事件或文本为空时返回 undefined。
 */
