/**
 * 本地自然日值对象。
 *
 * 存在的唯一理由：**时区归属必须只用一处实现**。「今日用量」「重置时刻」这类语义
 * 都以运行机器的本地日历日为准；一旦各处各自用 `slice(0,10)`（按 UTC 归日）或
 * `toISOString()` 截断，东八区用户在 08:00 之前产生的用量就会被记到前一天，
 * 表现为「余额早上凭空多出一截」。故统一收成一个值对象，谁要用谁持有它。
 */
export class LocalDay {
  /** 当日 23:59:59.999（本地）的自然日边界。 */
  private static readonly END_HOUR = 23;
  private static readonly END_MINUTE = 59;
  private static readonly END_SECOND = 59;
  private static readonly END_MILLIS = 999;

  private readonly date: Date;

  /**
   * @param date 参照时刻（只取其在本地时区下的年月日；时分秒毫秒一律忽略）
   */
  public constructor(date: Date) {
    this.date = date;
  }

  /**
   * 本地日期键（`YYYY-MM-DD`），用作按日聚合与比较的稳定标识。
   * @returns 本地日期键
   */
  public get key(): string {
    const month = String(this.date.getMonth() + 1).padStart(2, '0');
    const day = String(this.date.getDate()).padStart(2, '0');
    return `${this.date.getFullYear()}-${month}-${day}`;
  }

  /**
   * 本日的重置时刻（本地 23:59:59.999 的 ISO 串）。
   * @returns ISO 8601 字符串（含本地时区偏移）
   */
  public get endsAt(): string {
    const end = new Date(this.date.getTime());
    end.setHours(LocalDay.END_HOUR, LocalDay.END_MINUTE, LocalDay.END_SECOND, LocalDay.END_MILLIS);
    return end.toISOString();
  }

  /**
   * 判断某个 ISO 时间戳是否落在本日（本地时区）。
   * @param iso 候选时间戳；缺失、空串或非法格式一律返回 false（不把坏数据算进当日）
   * @returns 是否属于本日
   */
  public contains(iso: string | undefined): boolean {
    if (typeof iso !== 'string' || iso === '') return false;
    const parsed = new Date(iso);
    if (Number.isNaN(parsed.getTime())) return false;
    return new LocalDay(parsed).key === this.key;
  }
}
