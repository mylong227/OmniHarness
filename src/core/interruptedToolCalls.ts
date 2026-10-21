import type { SessionEvent } from '../ports/runtime/event.ts';

/** 一个「有调用、无结果」的悬空工具调用。 */
export interface InterruptedToolCall {
  readonly callId: string;
  readonly name: string;
}

/**
 * 悬空工具调用的对账（2026-10-21）。
 *
 * 场景：`StepToolExecutor` 先落 `tool_call` 事件、执行完才落配对的 `tool_result`。
 * 进程在两者之间崩溃/被杀时，日志里会留下一条**没有结果的工具调用**。
 * resume/fork 时若把它当普通历史投影，`ToolRoundSanitizer` 会把未响应的
 * `tool_calls` 静默剔除 —— 模型完全不知道「上次有个写操作可能执行了一半」，
 * 于是重跑同一个有副作用的调用。
 *
 * 因此 resume/fork 在追加新用户消息之前，必须为每条悬空调用补一条 `ok:false`
 * 的结果事件，把「执行状态未知」如实告诉模型。
 */
export class InterruptedToolCalls {
  /** 补录结果时给模型看的原因（要求模型先核对，不要盲目重试）。 */
  public static readonly MESSAGE =
    '【上次运行中断】该工具调用没有结果记录，执行状态未知（可能已部分产生副作用）。' +
    '请先核对工作区/进程状态，再决定是否重试；不要当成「从未执行」直接重跑。';

  /**
   * 把所有悬空调用补录为 `ok:false` 的「状态未知」结果（resume/fork 在追加新消息前调用）。
   * @param recorder 只需 `toolResult` 的窄接口（避免 core 内部类型环）。
   * @param events 完整历史事件。
   * @returns 补录条数。
   */
  public static recordInto(
    recorder: {
      toolResult: (callId: string, ok: boolean, output?: string, error?: string) => unknown;
    },
    events: readonly SessionEvent[],
  ): number {
    const pending = InterruptedToolCalls.pendingOf(events);
    for (const call of pending) {
      recorder.toolResult(
        call.callId,
        false,
        undefined,
        `${InterruptedToolCalls.MESSAGE}（工具：${call.name}）`,
      );
    }
    return pending.length;
  }

  /**
   * 找出事件流中所有没有配对 `tool_result` 的 `tool_call`。
   * @param events 完整历史事件（按时间顺序）。
   * @returns 悬空调用（按出现顺序、callId 去重）。
   */
  public static pendingOf(events: readonly SessionEvent[]): InterruptedToolCall[] {
    const pending = new Map<string, string>();
    const completed = new Set<string>();
    for (const event of events) {
      if (event.type === 'tool_call') {
        const payload = event.payload as { callId?: unknown; name?: unknown };
        if (typeof payload.callId === 'string' && payload.callId !== '') {
          pending.set(payload.callId, typeof payload.name === 'string' ? payload.name : '?');
        }
      } else if (event.type === 'tool_result') {
        const payload = event.payload as { callId?: unknown };
        if (typeof payload.callId === 'string' && payload.callId !== '') {
          completed.add(payload.callId);
        }
      }
    }
    const out: InterruptedToolCall[] = [];
    for (const [callId, name] of pending) {
      if (!completed.has(callId)) {
        out.push({ callId, name });
      }
    }
    return out;
  }
}
