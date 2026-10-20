import type { SessionEvent } from '../ports/runtime/event.ts';
import { MUTATING_TOOL_NAMES } from '../ports/tool/toolNames.ts';

/**
 * 续跑引导（LR-06）：从断点继续的用户消息。
 *
 * 单独成类是为了让 `Agent` 不继续膨胀（上帝类门禁）；这里只读事件日志，
 * 不持有任何会话状态，便于单测与复用。
 */
export class ResumeGuidance {
  /**
   * 构造续跑提示：列出最后 10 条**已成功执行的写类调用**，避免模型重复写同一文件/跑同一条命令。
   * @param events 已持久化的会话事件。
   * @returns 续跑用户消息（含可行动的去重清单）。
   */
  public static build(events: readonly SessionEvent[]): string {
    const mutating = MUTATING_TOOL_NAMES as ReadonlySet<string>;
    const calls = new Map<string, { name: string; target: string }>();
    for (const event of events) {
      if (event.type !== 'tool_call') continue;
      const payload = event.payload as {
        callId?: string;
        name?: string;
        args?: Record<string, unknown>;
      };
      if (
        payload.callId !== undefined &&
        payload.name !== undefined &&
        mutating.has(payload.name)
      ) {
        calls.set(payload.callId, {
          name: payload.name,
          target: ResumeGuidance.targetOf(payload.args),
        });
      }
    }
    const completed: string[] = [];
    for (const event of events) {
      if (event.type !== 'tool_result') continue;
      const payload = event.payload as { callId?: string; ok?: boolean };
      const call = payload.callId === undefined ? undefined : calls.get(payload.callId);
      if (payload.ok === true && call !== undefined) {
        completed.push(call.target === '' ? call.name : `${call.name} ${call.target}`);
      }
    }
    // 去重但保留顺序（同一文件重复写只列一次）。
    const recent = [...new Set(completed)].slice(-10);
    const suffix =
      recent.length === 0
        ? ''
        : `\n\n已成功执行的写类调用（不要重复；如已落盘请核对当前工作区）：\n${recent
            .map((line) => `- ${line}`)
            .join('\n')}`;
    return (
      '【续跑】上次任务在此中断。基于上方会话历史与当前工作区状态接着完成剩余工作，' +
      '不要重复已完成的步骤。' +
      suffix
    );
  }

  /**
   * 从工具参数里取一个可读目标（路径/命令/查询），用于区分同名调用。
   * @param args 工具调用参数。
   * @returns 截断后的目标文本；没有可识别字段时为空串。
   */
  private static targetOf(args: Record<string, unknown> | undefined): string {
    if (args === undefined) return '';
    for (const key of ['path', 'file_path', 'file', 'target', 'command', 'cmd', 'query']) {
      const value = args[key];
      if (typeof value === 'string' && value.trim() !== '') {
        const text = value.trim().replace(/\s+/g, ' ');
        return text.length <= 80 ? text : `${text.slice(0, 77)}...`;
      }
    }
    return '';
  }
}
