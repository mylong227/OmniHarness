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
    const names = new Map<string, string>();
    for (const event of events) {
      if (event.type !== 'tool_call') continue;
      const payload = event.payload as { callId?: string; name?: string };
      if (
        payload.callId !== undefined &&
        payload.name !== undefined &&
        mutating.has(payload.name)
      ) {
        names.set(payload.callId, payload.name);
      }
    }
    const completed: string[] = [];
    for (const event of events) {
      if (event.type !== 'tool_result') continue;
      const payload = event.payload as { callId?: string; ok?: boolean };
      const name = payload.callId === undefined ? undefined : names.get(payload.callId);
      if (payload.ok === true && name !== undefined) completed.push(name);
    }
    const recent = completed.slice(-10);
    const suffix =
      recent.length === 0
        ? ''
        : `\n\n已成功执行的写类调用（不要重复；如已落盘请核对当前工作区）：\n${recent
            .map((name) => `- ${name}`)
            .join('\n')}`;
    return (
      '【续跑】上次任务在此中断。基于上方会话历史与当前工作区状态接着完成剩余工作，' +
      '不要重复已完成的步骤。' +
      suffix
    );
  }
}
