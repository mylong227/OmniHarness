/**
 * 只读 trace 读取器适配器（T4.5 · H5）：把事件流（SessionEvent[]）投影为只读自省条目。
 *
 * - **只读保证**：每次查询返回深拷贝并逐条 Object.freeze——消费方（agent 自省工具、
 *   自评器）拿到的是快照，任何改动都是改副本，事件流本体不可触。
 * - **可复现**：条目 seq 取事件**在源事件流内**的稳定序号；同过滤条件 + 同事件流 ⇒ 恒同结果，
 *   且 `recent()` 与 `byKind()` 对同一条事件给出**同一个 seq**（否则「按 seq 回放定位」会指错）。
 * - **fail-soft**：provider 抛错（存储瞬断等）回空快照，不阻断自省调用方。
 * - 事件源以 getter 注入（`() => readonly SessionEvent[]`）：跟随 recorder 的实时视图。
 */
import type { SessionEvent } from '../../ports/runtime/event.js';
import type {
  TraceEntry,
  TraceIntrospectionPort,
} from '../../ports/intelligence/traceIntrospection.js';
import { ArrayAt } from '../../util/arrayAt.js';

/** 带源下标的事件（seq 语义的载体：下标属于**源事件流**，与过滤无关）。 */
interface IndexedEvent {
  /** 源事件。 */
  readonly event: SessionEvent;
  /** 该事件在源事件流内的下标。 */
  readonly index: number;
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
   *
   * @param k 返回条数上限（默认 20）
   * @returns 冻结的条目快照
   */
  public recent(k = 20): readonly TraceEntry[] {
    return this.take(this.indexed(this.events()), Math.max(0, k));
  }

  /**
   * 按类别取最近 k 条（新在前）。
   *
   * @param kind 事件类别（SessionEvent.type）
   * @param k 返回条数上限（默认 20）
   * @returns 冻结的条目快照（seq 仍是源事件流下标，不是过滤后子流下标）
   */
  public byKind(kind: string, k = 20): readonly TraceEntry[] {
    return this.take(
      this.indexed(this.events()).filter((entry) => entry.event.type === kind),
      Math.max(0, k),
    );
  }

  /**
   * 事件源读取。
   *
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
   * 给事件流打上源下标，供后续过滤时保留 seq 语义。
   *
   * @param events 源事件流
   * @returns 「事件 + 源下标」列表（顺序与源一致）
   */
  private indexed(events: readonly SessionEvent[]): readonly IndexedEvent[] {
    return events.map((event, index) => ({ event, index }));
  }

  /**
   * 投影 + 截断 + 冻结（深拷贝）。
   *
   * @param entries 带源下标的事件列表（已是所需的过滤/顺序）
   * @param k 截断条数
   * @returns 冻结条目数组（新在前；seq 取源下标）
   */
  private take(entries: readonly IndexedEvent[], k: number): readonly TraceEntry[] {
    const out: TraceEntry[] = [];
    for (let i = entries.length - 1; i >= 0 && out.length < k; i--) {
      const { event, index } = ArrayAt.at(entries, i);
      out.push(
        Object.freeze({
          seq: index,
          at: event.timestamp,
          kind: event.type,
          summary: this.summarize(event),
        }),
      );
    }
    return Object.freeze(out);
  }

  /**
   * 单行摘要投影：截断长文本，突出可读字段（tool / callId / error）。
   *
   * @param event 源事件
   * @returns 单行人类可读摘要
   */
  private summarize(event: SessionEvent): string {
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
}
