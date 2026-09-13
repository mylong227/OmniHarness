/**
 * 只读 trace 读取器适配器（T4.5 · H5）：把事件流（SessionEvent[]）投影为只读自省条目。
 *
 * - **只读保证**：每次查询返回深拷贝并逐条 Object.freeze——消费方（agent 自省工具、
 *   自评器）拿到的是快照，任何改动都是改副本，事件流本体不可触。
 * - **可复现**：条目 seq 取事件在流内的稳定序号；同过滤条件 + 同事件流 ⇒ 恒同结果。
 * - **fail-soft**：provider 抛错（存储瞬断等）回空快照，不阻断自省调用方。
 * - 事件源以 getter 注入（`() => readonly SessionEvent[]`）：跟随 recorder 的实时视图。
 */
import type { SessionEvent } from '../../ports/event.js';
import type { TraceEntry, TraceIntrospectionPort } from '../../ports/traceIntrospection.js';

/** 单行摘要的 payload 投影规则：截断长文本，突出可读字段。 */
function summarize(event: SessionEvent): string {
  const p = event.payload;
  if (p === null || p === undefined) return event.type;
  if (typeof p === 'string') return `${event.type}: ${p.slice(0, 120)}`;
  if (typeof p === 'object') {
    const obj = p as Record<string, unknown>;
    const tool = typeof obj['tool'] === 'string' ? String(obj['tool']) : undefined;
    const toolCall = typeof obj['callId'] === 'string' ? String(obj['callId']) : undefined;
    const error = typeof obj['error'] === 'string' ? String(obj['error']) : undefined;
    const parts = [event.type, tool, toolCall, error].filter((x) => x !== undefined);
    return parts.join(' · ').slice(0, 160);
  }
  return event.type;
}

/**
 * 只读 trace 读取器：TraceIntrospectionPort 的事件流实现。
 */
export class ReadonlyTraceReader implements TraceIntrospectionPort {
  /** 适配器标识名。 */
  public readonly name = 'readonly-trace-reader';
  /** 事件源（getter 注入；通常为 () => recorder.allEvents()）。 */
  private readonly provider: () => readonly SessionEvent[];

  /**
   * @param provider 事件源（getter 注入；通常为 `() => recorder.allEvents()`）
   */
  public constructor(provider: () => readonly SessionEvent[]) {
    this.provider = provider;
  }

  /**
   * 最近 k 条（新在前）。
   * @param k 返回条数上限（默认 20）
   * @returns 冻结的条目快照
   */
  public recent(k = 20): readonly TraceEntry[] {
    return this.take(this.events(), Math.max(0, k));
  }

  /**
   * 按类别取最近 k 条（新在前）。
   * @param kind 事件类别（SessionEvent.type）
   * @param k 返回条数上限（默认 20）
   * @returns 冻结的条目快照
   */
  public byKind(kind: string, k = 20): readonly TraceEntry[] {
    return this.take(
      this.events().filter((e) => e.type === kind),
      Math.max(0, k),
    );
  }

  /**
   * 事件源读取。
   * @returns 当前事件流；provider 抛错回空数组（fail-soft）
   */
  private events(): readonly SessionEvent[] {
    try {
      return this.provider();
    } catch {
      return [];
    }
  }

  /**
   * 投影 + 截断 + 冻结（深拷贝）。
   * @param events 事件流（已是所需的过滤/顺序）
   * @param k 截断条数
   * @returns 冻结条目数组
   */
  private take(events: readonly SessionEvent[], k: number): readonly TraceEntry[] {
    const out: TraceEntry[] = [];
    for (let i = events.length - 1; i >= 0 && out.length < k; i--) {
      const e = events[i]!;
      out.push(
        Object.freeze({
          seq: i,
          at: e.timestamp,
          kind: e.type,
          summary: summarize(e),
        }),
      );
    }
    return Object.freeze(out);
  }
}
