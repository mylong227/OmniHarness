// 检查点时间线：把扁平的检查点列表整理成「按天分组 + 相对时间 + 徽标 + 最新标记」的展示模型。
// 零 React 依赖、时间基准由调用方注入（now），故可在 node 下用固定时间戳确定性单测。
//
// 为什么不用 Date.now() 而注入 now：相对时间（「3 分钟前」）是**输入的函数**，
// 混入真实时钟会让测试在跨分钟/跨天时随机红——这类测试一旦随机红，团队就会去关掉它。

import { TimestampFormatter } from './checkpoint.js';
import type { CheckpointMeta } from './checkpoint.js';

/** 天毫秒数（分组与「N 天前」共用同一常量，避免两处各写一遍）。 */
const DAY_MS = 86400000;

/** 一条时间线条目：检查点 + 派生展示字段。 */
export interface TimelineEntry {
  /** 原始检查点元信息。 */
  readonly meta: CheckpointMeta;
  /** 相对时间文案（「刚刚」/「N 分钟前」/…；时间戳非法时为原文）。 */
  readonly relative: string;
  /** 绝对时间（本地化；时间戳非法时为原文）——挂 title 供悬停看精确值。 */
  readonly absolute: string;
  /** 是否含文件快照（决定了回滚能否还原代码，不只对话）。 */
  readonly hasSnapshot: boolean;
  /** 事件数。 */
  readonly eventCount: number;
  /** 是否为最新检查点（回滚面板给它打「当前最新」标记）。 */
  readonly latest: boolean;
}

/** 一个「天」分组。 */
export interface TimelineDay {
  /** 分组键：本地日期 `YYYY-MM-DD`。 */
  readonly key: string;
  /** 展示标题：「今天」/「昨天」/ 日期。 */
  readonly title: string;
  /** 组内条目（新 → 旧）。 */
  readonly items: readonly TimelineEntry[];
}

/** 检查点时间线构建器（纯静态，无状态）。 */
export class CheckpointTimeline {
  /**
   * 构建时间线：按本地日期分组（新天在前），组内新检查点在前。
   * @param items 检查点元信息（顺序任意，内部会确定性重排）
   * @param now 相对时间基准（测试注入固定值）
   * @param locale 绝对时间本地化（默认 zh-CN）
   * @returns 按天分组的时间线（输入为空时返回空数组）
   */
  public static build(
    items: readonly CheckpointMeta[],
    now: Date,
    locale = 'zh-CN',
  ): TimelineDay[] {
    const sorted = CheckpointTimeline.sortDesc(items);
    if (sorted.length === 0) return [];
    const days: TimelineDay[] = [];
    let current: { key: string; title: string; items: TimelineEntry[] } | null = null;
    let first = true;
    for (const meta of sorted) {
      const parsed = CheckpointTimeline.parse(meta.ts);
      const key = parsed === null ? 'unknown' : CheckpointTimeline.dayKey(new Date(parsed));
      if (current === null || current.key !== key) {
        current = { key, title: CheckpointTimeline.dayTitle(key, now), items: [] };
        days.push(current);
      }
      current.items.push({
        meta,
        relative: CheckpointTimeline.relative(meta.ts, now, locale),
        absolute: TimestampFormatter.format(meta.ts, locale),
        hasSnapshot: meta.hasFileSnapshot === true,
        eventCount: meta.eventCount,
        latest: first,
      });
      first = false;
    }
    return days;
  }

  /**
   * 确定性排序：时间戳倒序（新在前），时间戳非法者垫底，同刻按 label 升序。
   * @param items 检查点元信息
   * @returns 新数组（不改动入参）
   */
  public static sortDesc(items: readonly CheckpointMeta[]): CheckpointMeta[] {
    return items.slice().sort((a, b) => {
      const ta = CheckpointTimeline.parse(a.ts);
      const tb = CheckpointTimeline.parse(b.ts);
      if (ta === null && tb === null) return a.label < b.label ? -1 : a.label > b.label ? 1 : 0;
      if (ta === null) return 1;
      if (tb === null) return -1;
      if (ta !== tb) return tb - ta;
      return a.label < b.label ? -1 : a.label > b.label ? 1 : 0;
    });
  }

  /**
   * 相对时间文案。
   * @param ts 检查点时间戳（ISO 串）
   * @param now 相对基准
   * @param locale 绝对时间本地化（超过 7 天时回退到绝对时间）
   * @returns 「刚刚」/「N 分钟前」/「N 小时前」/「N 天前」/ 绝对时间
   */
  public static relative(ts: string, now: Date, locale = 'zh-CN'): string {
    const t = CheckpointTimeline.parse(ts);
    if (t === null) return ts;
    const diffSeconds = Math.floor((now.getTime() - t) / 1000);
    if (diffSeconds < 60) return '刚刚';
    if (diffSeconds < 3600) return Math.floor(diffSeconds / 60) + ' 分钟前';
    if (diffSeconds < DAY_MS / 1000) return Math.floor(diffSeconds / 3600) + ' 小时前';
    const days = Math.floor(diffSeconds / (DAY_MS / 1000));
    if (days < 7) return days + ' 天前';
    return TimestampFormatter.format(ts, locale);
  }

  /**
   * 本地日期分组键。
   * @param d 时间点
   * @returns `YYYY-MM-DD`（本地时区，避免 UTC 跨天把「今天」错分到昨天）
   */
  public static dayKey(d: Date): string {
    const pad = (n: number): string => (n < 10 ? '0' + String(n) : String(n));
    return String(d.getFullYear()) + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }

  /**
   * 分组标题：今天 / 昨天 / 日期。
   * @param key 分组键（`YYYY-MM-DD`，或 `unknown`）
   * @param now 相对基准
   * @returns 标题文案
   */
  public static dayTitle(key: string, now: Date): string {
    if (key === 'unknown') return '时间未知';
    if (key === CheckpointTimeline.dayKey(now)) return '今天';
    if (key === CheckpointTimeline.dayKey(new Date(now.getTime() - DAY_MS))) return '昨天';
    return key;
  }

  /**
   * 解析时间戳（fail-closed 到 null，由调用方决定展示什么）。
   * @param ts 时间戳字符串
   * @returns 毫秒时间戳；非法时为 null
   */
  public static parse(ts: string): number | null {
    const t = Date.parse(ts);
    return Number.isFinite(t) ? t : null;
  }
}
