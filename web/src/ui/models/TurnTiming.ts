// 每段对话的独立「本轮用时」（纯模型，零 React）。
//
// 口径：一条 user 事件开启一段对话，下一段 user 事件（或事件流结束）收口。
// 结束时刻取该段内**最后一个合法事件时间戳**（assistant / tool / turn_diff 等均可）。
// 历史会话与实时会话同一套判据：不依赖 UI 挂载时刻，也不读当前墙钟。
//
// 为什么不在 UserCard 里现算：卡片按块渲染，同一个事件会被虚拟窗口反复渲染；
// 这里一次算成 Map，组件只查表。也不把「进行中」段算成已完成——busy 时最后一段
// 未完，直接不展示，避免出现一个不会跳动的假读数（当前会话总时长在 ChatHeader 里实时刷新）。

import type { ThreadEvent } from '../../types/models.ts';

/** 一段对话的用时记录。 */
export interface TurnTimingRecord {
  /** 该段起始 user 事件 id。 */
  readonly userId: string;
  /** 起始/结束毫秒时间戳（0 表示时间戳不可得）。 */
  readonly startMs: number;
  readonly endMs: number;
  /** 用时（ms；不可得或为负时为 0）。 */
  readonly durationMs: number;
  /** 是否已收口（后面出现了下一段 user，或不再 busy）。 */
  readonly complete: boolean;
}

/**
 * 从事件流构建「user 事件 id → 本轮用时」。
 */
export class TurnTiming {
  /**
   * @param events 会话事件（按发生顺序）
   * @param busy 当前回合是否仍在进行
   * @returns user 事件 id 到用时记录的只读映射
   */
  public static build(
    events: readonly ThreadEvent[],
    busy: boolean,
  ): ReadonlyMap<string, TurnTimingRecord> {
    const out = new Map<string, TurnTimingRecord>();
    let current:
      | { readonly userId: string; readonly startMs: number; endMs: number }
      | undefined;
    const close = (complete: boolean): void => {
      if (current === undefined) return;
      const durationMs =
        current.startMs > 0 && current.endMs >= current.startMs
          ? current.endMs - current.startMs
          : 0;
      out.set(current.userId, {
        userId: current.userId,
        startMs: current.startMs,
        endMs: current.endMs,
        durationMs,
        complete,
      });
      current = undefined;
    };
    for (const ev of events) {
      const ts = TurnTiming.timestampOf(ev);
      if (ev.type === 'user') {
        close(true);
        current = { userId: ev.id, startMs: ts, endMs: ts };
        continue;
      }
      if (current !== undefined && ts > current.endMs) current.endMs = ts;
    }
    close(!busy);
    return out;
  }

  /**
   * 事件时间戳归一（与 TurnSummary 同口径）。
   * @param ev 事件
   * @returns 毫秒时间戳；不可用时 0
   */
  private static timestampOf(ev: ThreadEvent): number {
    const raw: unknown = ev.timestamp;
    if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) return raw;
    if (typeof raw === 'string') {
      const parsed = Date.parse(raw);
      if (Number.isFinite(parsed) && parsed > 0) return parsed;
    }
    return 0;
  }
}
