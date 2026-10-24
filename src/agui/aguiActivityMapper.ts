import { TOOL_NAMES } from '../ports/tool/toolNames.ts';
import type { SessionEvent } from '../ports/runtime/event.ts';
import type { AgUiEvent, AgUiJsonPatchOperation } from './aguiProtocol.ts';

/** 已开始但尚未结束的活动（工具调用 id → 活动消息标识）。 */
interface AgUiActiveActivity {
  /** 活动消息 id。 */
  readonly messageId: string;
  /** 活动类型。 */
  readonly activityType: string;
}

/**
 * 工具/子代理执行进展 → AG-UI `ACTIVITY_*` 事件。
 *
 * 真实接线依据：`EventType` 里**没有**独立的 subagent 事件类型（子代理轨迹由
 * `SubagentEventBridge` 内部收集，不广播到父事件流）。因此子代理活动从真实的
 * `subagent` 工具调用（`tool_call` / `tool_result` 的 `name === 'subagent'`）推导，
 * 绝不凭空伪造；没有对应事件时返回空数组。
 *
 * 每个工具调用发一条 `ACTIVITY_SNAPSHOT`（`status: running`），对应结果到达后
 * 发一条 `ACTIVITY_DELTA`（`/status` → completed / failed，失败时附 `/error`）。
 */
export class AgUiActivityMapper {
  /** 进行中的活动（结束后移除，避免长 run 无界增长）。 */
  private readonly active = new Map<string, AgUiActiveActivity>();

  /**
   * 把一条会话事件映射为活动事件。
   * @param event 会话事件。
   * @returns ACTIVITY_SNAPSHOT / ACTIVITY_DELTA；无活动语义时为空数组。
   */
  public eventsFor(event: SessionEvent): readonly AgUiEvent[] {
    const payload = this.payloadOf(event);
    switch (event.type) {
      case 'tool_call':
        return this.start(payload);
      case 'tool_result':
        return this.finish(payload);
      default:
        return [];
    }
  }

  /**
   * 工具调用开始 → 活动快照。
   * @param payload 事件负载（callId / name / args）。
   * @returns ACTIVITY_SNAPSHOT；缺少 callId 时为空数组。
   */
  private start(payload: Readonly<Record<string, unknown>>): readonly AgUiEvent[] {
    const toolCallId = this.textOf(payload, 'callId');
    if (toolCallId === '') {
      return [];
    }
    const name = this.textOf(payload, 'name');
    const subagent = name === TOOL_NAMES.subagent;
    const activityType = subagent ? 'SUBAGENT' : 'TOOL_CALL';
    const messageId = `${subagent ? 'activity-subagent' : 'activity-tool'}-${toolCallId}`;
    const content = this.contentOf(subagent, toolCallId, name, payload);
    this.active.set(toolCallId, { messageId, activityType });
    return [
      {
        type: 'ACTIVITY_SNAPSHOT',
        messageId,
        activityType,
        content,
        timestamp: Date.now(),
      },
    ];
  }

  /**
   * 工具结果 → 活动增量（只更新已存在的活动，避免伪造开始事件）。
   * @param payload 事件负载（callId / ok / error）。
   * @returns ACTIVITY_DELTA；没有对应开始事件时为空数组。
   */
  private finish(payload: Readonly<Record<string, unknown>>): readonly AgUiEvent[] {
    const toolCallId = this.textOf(payload, 'callId');
    const activity = this.active.get(toolCallId);
    if (activity === undefined) {
      return [];
    }
    this.active.delete(toolCallId);
    const ok = payload['ok'] === true;
    const patch: AgUiJsonPatchOperation[] = [
      { op: 'replace', path: '/status', value: ok ? 'completed' : 'failed' },
    ];
    const error = this.textOf(payload, 'error');
    if (!ok && error !== '') {
      patch.push({ op: 'add', path: '/error', value: error });
    }
    return [
      {
        type: 'ACTIVITY_DELTA',
        messageId: activity.messageId,
        activityType: activity.activityType,
        patch,
        timestamp: Date.now(),
      },
    ];
  }

  /**
   * 构造活动内容（工具名 / 参数 / 子代理任务）。
   * @param subagent 是否为子代理调用。
   * @param toolCallId 工具调用 id。
   * @param name 工具名。
   * @param payload 事件负载。
   * @returns 活动内容对象。
   */
  private contentOf(
    subagent: boolean,
    toolCallId: string,
    name: string,
    payload: Readonly<Record<string, unknown>>,
  ): Readonly<Record<string, unknown>> {
    const args = payload['args'] ?? {};
    const content: Record<string, unknown> = {
      toolCallId,
      name,
      status: 'running',
      args,
    };
    if (!subagent) {
      return content;
    }
    const fields = this.recordOf(args);
    const task = this.textOf(fields, 'task');
    if (task !== '') {
      content['task'] = task;
    }
    if (Array.isArray(fields['tools'])) {
      content['tools'] = fields['tools'];
    }
    return content;
  }

  /**
   * 事件负载归一为普通对象。
   * @param event 会话事件。
   * @returns 负载对象（非对象负载回落空对象）。
   */
  private payloadOf(event: SessionEvent): Readonly<Record<string, unknown>> {
    return this.recordOf(event.payload);
  }

  /**
   * 把未知值收窄为普通对象。
   * @param value 待收窄值。
   * @returns 普通对象（数组 / null / 原始值回落空对象）。
   */
  private recordOf(value: unknown): Readonly<Record<string, unknown>> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Readonly<Record<string, unknown>>)
      : {};
  }

  /**
   * 取字符串字段。
   * @param record 记录。
   * @param key 字段名。
   * @returns 文本（非字符串为空串）。
   */
  private textOf(record: Readonly<Record<string, unknown>>, key: string): string {
    const value = record[key];
    return typeof value === 'string' ? value : '';
  }
}
