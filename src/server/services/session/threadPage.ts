/**
 * `threads.get` 的**纯分页切片**（2026-10-25，S2）。
 *
 * 大会话（几十 MB 的截图/长日志）整档返回会把 TTFB 变成「全量序列化时间」，前端也要一次性
 * 持有全部事件。分页默认取**尾部**（用户最常看最近内容），向上用 `before=<eventId>` 补拉。
 *
 * ## 契约
 *
 * - 不给 `limit` ⇒ 返回全部（向后兼容旧客户端）；
 * - `before` 是事件 id，返回**它之前**的 `limit` 条（不含该条）；
 * - `before` 找不到 ⇒ `{ items: [], error: 'unknown_before' }`，不猜、不静默从头返回；
 * - `hasMore` 只表示「更早还有」，不表示「更晚」。
 */

import type { SessionEvent } from '../../../ports/runtime/event.ts';

/** 分页切片结果。 */
export interface ThreadPageSlice {
  /** 本页事件（时间顺序）。 */
  readonly items: readonly SessionEvent[];
  /** 更早是否还有事件。 */
  readonly hasMore: boolean;
  /** 本页最早事件 id（下一页的 `before`）；空页时不出现。 */
  readonly oldestId?: string;
  /** 参数错误（目前只有 unknown_before）。 */
  readonly error?: string;
}

/** `threads.get` 分页器。 */
export class ThreadPage {
  /** 单页上限：超过 1000 条不再有意义（前端也会卡）。 */
  public static readonly MAX_LIMIT = 1000;

  /**
   * 切一页。
   * @param events 全部事件（时间顺序）。
   * @param limit 页大小；undefined/0 表示不分页。
   * @param before 上一页最早事件 id（返回它之前的页）。
   * @returns 分页结果。
   */
  public static slice(
    events: readonly SessionEvent[],
    limit?: number,
    before?: string,
  ): ThreadPageSlice {
    const size =
      limit === undefined || limit <= 0
        ? undefined
        : Math.min(ThreadPage.MAX_LIMIT, Math.floor(limit));
    let end = events.length;
    if (before !== undefined && before !== '') {
      const index = events.findIndex((event) => event.id === before);
      if (index < 0) {
        return { items: [], hasMore: false, error: 'unknown_before' };
      }
      end = index;
    }
    const start = size === undefined ? 0 : Math.max(0, end - size);
    const items = events.slice(start, end);
    const oldest = items[0]?.id;
    return {
      items,
      hasMore: start > 0,
      ...(oldest !== undefined ? { oldestId: oldest } : {}),
    };
  }
}
