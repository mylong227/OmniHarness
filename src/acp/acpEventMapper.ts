import type { SessionEvent } from '../ports/runtime/event.ts';
import { TOOL_NAMES } from '../ports/tool/toolNames.ts';
import type {
  AcpContentBlock,
  AcpMessageChunkUpdate,
  AcpPlanEntry,
  AcpPlanEntryStatus,
  AcpSessionUpdate,
  AcpToolCallContent,
  AcpToolKind,
} from './acpProtocol.ts';

/** 映射选项。 */
export interface AcpMapOptions {
  /** 是否为 session/load 的历史回放（回放时才发 user_message_chunk）。 */
  readonly replay?: boolean;
}

/**
 * 会话事件 → ACP `session/update` 的映射器（**单会话实例**）。
 *
 * 保持有状态的部分只有「工具调用 id → 工具名」，用于给 `tool_call_update` 补标题；
 * 其余映射都是纯函数式，同一事件重复映射不产生额外副作用。
 */
export class AcpEventMapper {
  /** 已见过的工具调用（callId → 工具名），供结果更新补全标题。 */
  private readonly toolNames = new Map<string, string>();

  /**
   * 把一条会话事件映射为 0..N 条 ACP 会话更新。
   * @param event 会话事件（user/assistant/reasoning/tool_call/tool_result/todo/plan）。
   * @param options 映射选项（`replay` 控制是否回显用户消息）。
   * @returns 该事件对应的 ACP 更新序列（不可映射的事件返回空数组）。
   */
  public map(event: SessionEvent, options: AcpMapOptions = {}): readonly AcpSessionUpdate[] {
    const payload = AcpEventMapper.payloadOf(event);
    switch (event.type) {
      case 'user':
        return options.replay === true
          ? [this.messageChunk('user_message_chunk', event.id, AcpEventMapper.textOf(payload))]
          : [];
      case 'assistant':
        return this.assistantUpdates(event, payload);
      case 'reasoning':
        return this.reasoningUpdates(event, payload);
      case 'tool_call':
        return this.toolCallUpdates(event, payload);
      case 'tool_result':
        return this.toolResultUpdates(event, payload);
      case 'todo':
        return this.todoUpdates(payload);
      case 'plan':
        return this.planUpdates(payload);
      default:
        return [];
    }
  }

  /** 清空工具名缓存（会话重载/关闭时调用）。     * @returns 无返回值。
   */
  public reset(): void {
    this.toolNames.clear();
  }

  /**
   * assistant 事件：正文 → agent_message_chunk；思考链（payload.reasoning）→ agent_thought_chunk。
   * @param event 源事件。
   * @param payload 事件负载。
   * @returns ACP 更新序列。
   */
  private assistantUpdates(
    event: SessionEvent,
    payload: Record<string, unknown>,
  ): readonly AcpSessionUpdate[] {
    const updates: AcpSessionUpdate[] = [];
    const reasoning = AcpEventMapper.textOf(payload, 'reasoning');
    if (reasoning !== '') {
      updates.push(this.messageChunk('agent_thought_chunk', `${event.id}-thought`, reasoning));
    }
    const content = AcpEventMapper.textOf(payload);
    if (content !== '') {
      updates.push(this.messageChunk('agent_message_chunk', event.id, content));
    }
    return updates;
  }

  /**
   * reasoning 事件 → agent_thought_chunk。
   * @param event 源事件。
   * @param payload 事件负载。
   * @returns ACP 更新序列。
   */
  private reasoningUpdates(
    event: SessionEvent,
    payload: Record<string, unknown>,
  ): readonly AcpSessionUpdate[] {
    const content = AcpEventMapper.textOf(payload);
    return content === '' ? [] : [this.messageChunk('agent_thought_chunk', event.id, content)];
  }

  /**
   * tool_call 事件 → 新建 tool_call 更新。
   * @param event 源事件。
   * @param payload 事件负载（callId / name / args）。
   * @returns ACP 更新序列。
   */
  private toolCallUpdates(
    event: SessionEvent,
    payload: Record<string, unknown>,
  ): readonly AcpSessionUpdate[] {
    const callId = AcpEventMapper.textOf(payload, 'callId');
    const name = AcpEventMapper.textOf(payload, 'name');
    if (callId === '') return [];
    this.toolNames.set(callId, name);
    const args = AcpEventMapper.recordOf(payload['args']);
    return [
      {
        sessionUpdate: 'tool_call',
        toolCallId: callId,
        title: AcpEventMapper.titleOf(name, args, event.type),
        name,
        kind: AcpEventMapper.kindOf(name),
        status: 'pending',
        rawInput: args,
      },
    ];
  }

  /**
   * tool_result 事件 → tool_call_update（completed/failed + 文本内容）。
   * @param event 源事件。
   * @param payload 事件负载（callId / ok / output / error）。
   * @returns ACP 更新序列。
   */
  private toolResultUpdates(
    event: SessionEvent,
    payload: Record<string, unknown>,
  ): readonly AcpSessionUpdate[] {
    const callId = AcpEventMapper.textOf(payload, 'callId');
    if (callId === '') return [];
    const ok = payload['ok'] === true;
    const output = AcpEventMapper.textOf(payload, 'output');
    const failure = AcpEventMapper.textOf(payload, 'error');
    const text = ok ? output : failure === '' ? '工具执行失败' : failure;
    const content: readonly AcpToolCallContent[] =
      text === '' ? [] : [{ type: 'content', content: { type: 'text', text } }];
    const name = this.toolNames.get(callId) ?? '';
    return [
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: callId,
        status: ok ? 'completed' : 'failed',
        ...(name !== '' ? { title: AcpEventMapper.titleOf(name, {}, event.type) } : {}),
        ...(content.length > 0 ? { content } : {}),
        rawOutput: ok ? output : failure,
      },
    ];
  }

  /**
   * todo 事件 → plan 更新（todo 的三种状态与 ACP 计划项状态同名）。
   * @param payload 事件负载（todos）。
   * @returns ACP 更新序列。
   */
  private todoUpdates(payload: Record<string, unknown>): readonly AcpSessionUpdate[] {
    const entries = AcpEventMapper.entriesOf(payload['todos'], (item) => {
      const content = AcpEventMapper.textOf(item, 'content');
      if (content === '') return undefined;
      const raw = AcpEventMapper.textOf(item, 'status');
      const status: AcpPlanEntryStatus =
        raw === 'completed' || raw === 'in_progress' ? raw : 'pending';
      return { content, priority: 'medium' as const, status };
    });
    return entries.length === 0 ? [] : [{ sessionUpdate: 'plan', entries }];
  }

  /**
   * plan 事件 → plan 更新（`PlanState.steps` 的 done 映射为 completed）。
   * @param payload 事件负载（PlanState：title / steps / status）。
   * @returns ACP 更新序列。
   */
  private planUpdates(payload: Record<string, unknown>): readonly AcpSessionUpdate[] {
    const entries = AcpEventMapper.entriesOf(payload['steps'], (item) => {
      const content = AcpEventMapper.textOf(item, 'description');
      if (content === '') return undefined;
      const done = AcpEventMapper.textOf(item, 'status') === 'done';
      return { content, priority: 'high' as const, status: done ? 'completed' : 'pending' };
    });
    return entries.length === 0 ? [] : [{ sessionUpdate: 'plan', entries }];
  }

  /**
   * 构造一条消息分片更新。
   * @param kind 更新类别。
   * @param messageId 消息 id。
   * @param text 文本内容。
   * @returns ACP 消息更新。
   */
  private messageChunk(
    kind: AcpMessageChunkUpdate['sessionUpdate'],
    messageId: string,
    text: string,
  ): AcpMessageChunkUpdate {
    const content: AcpContentBlock = { type: 'text', text };
    return { sessionUpdate: kind, messageId, content };
  }

  /**
   * 事件负载归一为普通对象（非对象/数组返回空对象）。
   * @param event 会话事件。
   * @returns 负载对象。
   */
  private static payloadOf(event: SessionEvent): Record<string, unknown> {
    return AcpEventMapper.recordOf(event.payload);
  }

  /**
   * 取字符串字段（缺省或非字符串返回空串）。
   * @param record 记录。
   * @param key 字段名（缺省 `content`）。
   * @returns 字段文本。
   */
  private static textOf(record: Record<string, unknown>, key = 'content'): string {
    const value = record[key];
    return typeof value === 'string' ? value : '';
  }

  /**
   * 取普通对象字段（非对象返回空对象）。
   * @param value 待判值。
   * @returns 普通对象。
   */
  private static recordOf(value: unknown): Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  }

  /**
   * 把数组载荷映射为计划条目（丢弃无法识别的项）。
   * @param value 原始数组值。
   * @param pick 单项映射函数（返回 undefined 表示丢弃）。
   * @returns 计划条目数组。
   */
  private static entriesOf(
    value: unknown,
    pick: (item: Record<string, unknown>) => AcpPlanEntry | undefined,
  ): readonly AcpPlanEntry[] {
    if (!Array.isArray(value)) return [];
    const out: AcpPlanEntry[] = [];
    for (const item of value) {
      const entry = pick(AcpEventMapper.recordOf(item));
      if (entry !== undefined) out.push(entry);
    }
    return out;
  }

  /**
   * 工具标题：`工具名: 目标`（无目标时只用工具名）。
   * @param name 工具名。
   * @param args 工具入参。
   * @param eventType 事件类型（异常时用于兜底）。
   * @returns 人类可读标题。
   */
  private static titleOf(name: string, args: Record<string, unknown>, eventType: string): string {
    const target =
      args['command'] ??
      args['path'] ??
      args['url'] ??
      args['goal'] ??
      args['prompt'] ??
      args['file'] ??
      args['query'];
    if (typeof target === 'string' && target.trim() !== '') {
      return `${name === '' ? eventType : name}: ${target.slice(0, 160)}`;
    }
    return name === '' ? eventType : name;
  }

  /**
   * 工具名 → ACP 工具类别。
   * @param name 工具名。
   * @returns ACP 工具类别（未知工具为 other）。
   */
  private static kindOf(name: string): AcpToolKind {
    switch (name) {
      case TOOL_NAMES.readFile:
      case TOOL_NAMES.listDir:
      case TOOL_NAMES.glob:
      case TOOL_NAMES.grep:
      case TOOL_NAMES.viewImage:
      case TOOL_NAMES.viewMedia:
      case TOOL_NAMES.recall:
      case TOOL_NAMES.memorySearch:
      case TOOL_NAMES.planRead:
      case TOOL_NAMES.todoRead:
      case TOOL_NAMES.spillRead:
        return 'read';
      case TOOL_NAMES.writeFile:
      case TOOL_NAMES.edit:
      case TOOL_NAMES.applyPatch:
      case TOOL_NAMES.patchCandidates:
        return 'edit';
      case TOOL_NAMES.shell:
      case TOOL_NAMES.shellJob:
      case TOOL_NAMES.shellInteractive:
      case TOOL_NAMES.runCode:
        return 'execute';
      case TOOL_NAMES.webSearch:
      case TOOL_NAMES.webFetch:
        return 'fetch';
      case TOOL_NAMES.askUser:
        return 'think';
      case TOOL_NAMES.planWrite:
      case TOOL_NAMES.planPresent:
        return 'think';
      default:
        return 'other';
    }
  }
}
