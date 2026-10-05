/**
 * 定时任务调度器（D3）：纯 TS、核心零第三方（Wave A.5 起**可选**注入 `CronSchedulePort` 实现）。
 *
 * 调度支持两种形式：
 * - interval：每 N 分钟跑一次（适合「周期性巡检」）。
 * - cron：5 段标准 cron 表达式（分 时 日 月 周），支持 * , - /（步长）。
 *
 * **时区/DST（Wave A.5）**：默认走**本模块自研的字段匹配**（`matchesCron`）——它用**宿主本地时区**的
 * `getHours/getDate/getDay` 判定（**不是 UTC**，2026-10-04 实测确认），因此：
 * ① 同一份 routines.json 在不同宿主时区的机器上**触发时刻不同**（环境相关，可复现性缺陷）；
 * ② 无法表达「按指定 IANA 时区准点触发」，也不处理夏令时跳变（本地 02:30 可能不存在或出现两次）。
 * 要按明确时区准点触发，在构造时注入 `cron`（`CronerSchedule`）：此时 cron 型任务的到期判定改用
 * 带 IANA 时区的「上次之后的下一个触发时刻」；interval 型任务与持久化语义**完全不变**。
 * **不注入 = 行为与既有版本逐位一致**（兼容路径显式保留；既有本地时区语义的迁移见
 * `docs/PROJECT_BOARD.md` 第三十五轮登记的边界）。
 *
 * 持久化到 routines.json；`runDue(now)` 返回本次应立即执行的任务（按 lastRun 防同分钟重复）。
 * 执行动作（真正跑 Agent）由 CLI 层负责，本模块只负责「何时该跑」的判定与存储。
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { homedir } from 'node:os';
import type { Routine } from '../ports/daemon/routine.js';
import type { RoutineModelAdapter } from '../ports/daemon/routineModelAdapter.js';
import type { RoutineSchedule } from '../ports/daemon/routineSchedule.js';
import type { CronSchedulePort } from '../ports/daemon/cronSchedule.js';

/**
 * 定时任务相关契约（唯一声明见 `src/ports/daemon/`：`routine.ts` / `routineModelAdapter.ts` /
 * `routineSchedule.ts`；此处为原路径再导出，调用点零改动）。
 */
export type { Routine, RoutineModelAdapter, RoutineSchedule };

/**
 * 调度器装配项（可选能力；不传则全部保持既有行为）。
 */
export interface RoutineSchedulerOptions {
  /** cron 调度实现（Wave A.5）：注入后 cron 型任务按 IANA 时区判定到期。 */
  readonly cron?: CronSchedulePort | undefined;
  /** cron 判定所用时区（缺省由 `cron` 实现的确定性默认值决定，本仓为 `UTC`）。 */
  readonly timezone?: string | undefined;
}

/** 把单段 cron 字段（如「每5分」「1-3,9」「任意」）展开为命中的数值集合。 */

/**
 * @beta
 * 定时任务调度器（含持久化）。
 */
export class RoutineScheduler {
  /** 持久化文件路径（routines.json）。 */
  private readonly storePath: string;
  /** cron 调度实现（缺省 undefined = 自研 UTC 字段匹配，兼容路径）。 */
  private readonly cron?: CronSchedulePort | undefined;
  /** cron 判定时区（缺省交给实现决定）。 */
  private readonly timezone?: string | undefined;

  /**
   * 创建调度器。
   * @param storePath 存储文件路径（缺省 ~/.omniharness/routines.json）
   * @param opts 可选能力（cron 调度实现 + 时区）；省略即既有行为
   */
  public constructor(
    storePath: string = RoutineScheduler.defaultStorePath(),
    opts: RoutineSchedulerOptions = {},
  ) {
    this.storePath = storePath;
    this.cron = opts.cron;
    this.timezone = opts.timezone;
  }

  /**
   * 本调度器是否走带时区的 cron 实现（供 CLI/daemon 如实申报能力边界）。
   * @returns 注入了 `CronSchedulePort` 为 true
   */
  public timezoneAware(): boolean {
    return this.cron !== undefined;
  }

  /**
   * 列出全部任务。
   * @returns 全部任务数组（含 lastRun）。
   */
  public list(): Routine[] {
    const store = this.load();
    return [...store.routines];
  }

  /**
   * 新增/覆盖任务（按 name 幂等）。
   * @param routine 待写入的任务定义。
   * @returns 无返回值（覆盖时保留原 lastRun）。
   */
  public add(routine: Routine): void {
    const store = this.load();
    const idx = store.routines.findIndex((r) => r.name === routine.name);
    if (idx >= 0) {
      // 保留原有 lastRun，避免覆盖后丢失进度。
      store.routines[idx] = { ...routine, lastRun: store.routines[idx]?.lastRun };
    } else {
      store.routines.push(routine);
    }
    this.save(store);
  }

  /**
   * 删除任务；不存在返回 false。
   * @param name 任务名。
   * @returns 是否真的删除了任务。
   */
  public remove(name: string): boolean {
    const store = this.load();
    const before = store.routines.length;
    store.routines = store.routines.filter((r) => r.name !== name);
    if (store.routines.length === before) return false;
    this.save(store);
    return true;
  }

  /**
   * 标记任务已执行（更新 lastRun）。
   * @param name 任务名（不存在则忽略）。
   * @param at 执行时间戳（毫秒）。
   * @returns 无返回值。
   */
  public markRun(name: string, at: number): void {
    const store = this.load();
    const exists = store.routines.some((r) => r.name === name);
    if (!exists) return;
    store.routines = store.routines.map((r) => (r.name === name ? { ...r, lastRun: at } : r));
    this.save(store);
  }

  /**
   * 返回截至 now 应执行的任务（interval 到期 / cron 命中且距上次≥1 分钟）。
   * @param now 判定基准时间戳（毫秒，缺省当前时间）。
   * @returns 本次应执行的任务数组（按存储顺序）。
   */
  public runDue(now: number = Date.now()): Routine[] {
    const store = this.load();
    const due: Routine[] = [];
    for (const routine of store.routines) {
      if (this.isDue(routine, now)) {
        due.push(routine);
      }
    }
    return due;
  }

  /**
   * 单任务判定。
   *
   * cron 型任务的到期语义（两条路径**都给确定性结论**，但时区口径不同——已在门面文档写明）：
   * - 自研路径（未注入 `cron`）：`matchesCron` 用**宿主本地时区**字段匹配「当前这一分钟是否命中」（环境相关，历史行为）；
   * - 注入路径：取「(上次执行时刻 ?? 一分钟前) 之后的下一个触发时刻」，若 ≤ now 即到期
   *   —— 这与自研路径在分钟粒度上等价，但**带 IANA 时区与 DST 语义**。
   *   注意「合法但永不匹配」（如 `0 0 30 2 *`）⇒ `atMs === null` ⇒ 判定为**不到期**（不是错误、不抛）。
   * @param routine 待判定任务。
   * @param now 判定基准时间戳（毫秒）。
   * @returns 到期返回 true（同分钟内不重复触发）。
   */
  private isDue(routine: Routine, now: number): boolean {
    if (routine.lastRun !== undefined && now - routine.lastRun < 60_000) {
      return false; // 同分钟内不重复触发。
    }
    if (routine.schedule.kind === 'interval') {
      const gap = routine.schedule.minutes * 60_000;
      if (routine.lastRun === undefined) return true;
      return now - routine.lastRun >= gap;
    }
    if (this.cron !== undefined) {
      const anchor = routine.lastRun ?? now - 60_000;
      const next = this.cron.nextRunAt(routine.schedule.expr, anchor, this.timezone);
      if (!next.ok) return false; // 表达式/时区非法 ⇒ 不到期（fail-closed，不误触发）。
      return next.atMs !== null && next.atMs <= now;
    }
    // 与上面的 `croner` 路径同口径：**显式时区**（缺省 UTC），不再读宿主本地时间——
    // 否则同一 routine 在时区不同的机器上会在不同时刻触发（见 `matchesCron` 的迁移说明）。
    return RoutineScheduler.matchesCron(
      routine.schedule.expr,
      new Date(now),
      this.timezone ?? 'UTC',
    );
  }

  /**
   * 从磁盘读任务存储。
   *
   * 文件缺失 → 空表（首次启动的正常形态）。文件**损坏**（截断/非法 JSON）→ **隔离并抛错**：
   * 旧实现静默返回空表，而下一次 add/remove/markRun 会把这份空表**原样写回**，
   * 于是用户此前定义的全部定时任务被无声抹掉（2026-09-26 审计 S24）。
   * @returns `{ routines }` 存储结构。
   */
  private load(): { routines: Routine[] } {
    if (!existsSync(this.storePath)) {
      return { routines: [] };
    }
    const raw = readFileSync(this.storePath, 'utf8');
    let parsed: { routines?: Routine[] };
    try {
      parsed = JSON.parse(raw) as { routines?: Routine[] };
    } catch (error) {
      // 先留证（重命名而非删除），再 fail-closed 抛错——绝不覆盖可能还可人工修复的内容。
      const quarantine = `${this.storePath}.corrupt-${String(Date.now())}`;
      try {
        renameSync(this.storePath, quarantine);
      } catch {
        /* 留证失败不掩盖原始错误 */
      }
      throw new Error(
        `定时任务存储损坏（已隔离到 ${quarantine}，未覆盖）：${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return { routines: Array.isArray(parsed.routines) ? parsed.routines : [] };
  }

  /**
   * 任务存储落盘（先写临时文件再原子 rename，自动建目录）。
   *
   * 原子性理由：直接 `writeFileSync` 中途崩溃会留下**截断的半份 JSON**，
   * 而损坏文件在下次启动即触发上面的隔离路径——即一次崩溃毁掉全部任务。
   * @param store 待写入的存储结构。
   * @returns 无返回值。
   */
  private save(store: { routines: Routine[] }): void {
    mkdirSync(dirname(this.storePath), { recursive: true });
    const tmp = `${this.storePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(store, null, 2), 'utf8');
    renameSync(tmp, this.storePath);
  }
  /**
   * expandField — module-level helper moved into RoutineScheduler.
   * @param {string} field - field
   * @param {number} min - min
   * @param {number} max - max
   * @returns {Set<number>} - result
   */
  public static expandField(field: string, min: number, max: number): Set<number> {
    const out = new Set<number>();
    for (const part of field.split(',')) {
      if (part === '*') {
        for (let v = min; v <= max; v += 1) out.add(v);
        continue;
      }
      let step = 1;
      let range = part;
      const slash = part.indexOf('/');
      if (slash >= 0) {
        step = Number.parseInt(part.slice(slash + 1), 10);
        if (Number.isNaN(step) || step < 1) step = 1;
        range = part.slice(0, slash);
      }
      let lo = min;
      let hi = max;
      const dash = range.indexOf('-');
      if (dash >= 0) {
        lo = Number.parseInt(range.slice(0, dash), 10);
        hi = Number.parseInt(range.slice(dash + 1), 10);
      } else if (range !== '*') {
        lo = Number.parseInt(range, 10);
        hi = lo;
      }
      if (Number.isNaN(lo) || Number.isNaN(hi)) continue;
      lo = Math.max(min, lo);
      hi = Math.min(max, hi);
      for (let v = lo; v <= hi; v += step) out.add(v);
    }
    return out;
  }
  /**
   * defaultStorePath — module-level helper moved into RoutineScheduler.
   * @returns {string} - result
   */
  private static defaultStorePath(): string {
    return resolve(homedir(), '.omniharness', 'routines.json');
  }

  /**
   * @beta
   * 判定 cron 表达式是否命中给定时间（同分钟只算一次）。
   *
   * **时区是显式参数**（缺省 `UTC`）——这是 2026-10-04 的**行为修正**：此前用
   * `date.getHours()` 等**宿主本地**取值判定（同一表达式在时区不同的机器上会在**不同时刻**触发，
   * 而"什么时候跑"恰恰是调度器唯一要保证的事）。现在字段值一律经 `Intl.DateTimeFormat`
   * 在**指定时区**下求取，与宿主环境无关；注入 `croner` 路径本就带时区，两侧口径至此一致。
   *
   * 迁移说明（§12.1-6 兼容与迁移显式化）：默认从「宿主本地」变为 `UTC`。要保留原来的本地语义，
   * 显式传 `Intl.DateTimeFormat().resolvedOptions().timeZone` 即可——**不做隐式回退**，
   * 因为"看起来还是本地时间"正是这条缺陷当初难以察觉的原因。
   * @param expr 5 段标准 cron 表达式（分 时 日 月 周）。
   * @param date 待判定的时刻（绝对时间；字段值按 `timezone` 求取）。
   * @param timezone IANA 时区名（缺省 `UTC`；非法时区名按不命中处理，不抛）。
   * @returns 命中返回 true（表达式非法或时区非法返回 false）。
   */
  public static matchesCron(expr: string, date: Date, timezone = 'UTC'): boolean {
    const fields = expr.trim().split(/\s+/);
    if (fields.length !== 5) return false;
    const parts = RoutineScheduler.zonedParts(date, timezone);
    if (parts === undefined) return false;
    const minute = RoutineScheduler.expandField(fields[0] ?? '*', 0, 59);
    const hour = RoutineScheduler.expandField(fields[1] ?? '*', 0, 23);
    const dom = RoutineScheduler.expandField(fields[2] ?? '*', 1, 31);
    const month = RoutineScheduler.expandField(fields[3] ?? '*', 1, 12);
    const dow = RoutineScheduler.expandField(fields[4] ?? '*', 0, 6);
    if (!minute.has(parts.minute)) return false;
    if (!hour.has(parts.hour)) return false;
    if (!month.has(parts.month)) return false;
    // 日/周：cron 约定「日或周命中即触发」（取并集）。
    const domHit = dom.has(parts.day);
    const dowHit = dow.has(parts.weekday);
    if (!domHit && !dowHit) return false;
    return true;
  }

  /**
   * 取某时刻在指定时区下的**日历字段**（cron 判定用的那一组）。
   *
   * 用 `Intl.DateTimeFormat` 而不是自己加偏移：夏令时切换日的偏移并非常量，
   * 手算偏移会在一小时里给出错误字段（而 cron 的日/周字段恰恰按**当地日历**定义）。
   * @param date 时刻
   * @param timezone IANA 时区名
   * @returns 字段值；时区名非法时 undefined（调用方按不命中处理）
   */
  private static zonedParts(
    date: Date,
    timezone: string,
  ):
    | {
        readonly minute: number;
        readonly hour: number;
        readonly day: number;
        readonly month: number;
        readonly weekday: number;
      }
    | undefined {
    try {
      const formatter = new Intl.DateTimeFormat('en-US', {
        timeZone: timezone,
        hour12: false,
        minute: '2-digit',
        hour: '2-digit',
        day: '2-digit',
        month: '2-digit',
        weekday: 'short',
      });
      const parts = formatter.formatToParts(date);
      const value = (type: string): string | undefined =>
        parts.find((part) => part.type === type)?.value;
      const weekdayName = value('weekday') ?? '';
      const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(weekdayName);
      const minute = Number(value('minute'));
      const hour = Number(value('hour'));
      const day = Number(value('day'));
      const month = Number(value('month'));
      if (
        weekday < 0 ||
        !Number.isFinite(minute) ||
        !Number.isFinite(hour) ||
        !Number.isFinite(day) ||
        !Number.isFinite(month)
      ) {
        return undefined;
      }
      return { minute, hour, day, month, weekday };
    } catch {
      return undefined; // 非法时区名 ⇒ 不命中（fail-closed：不猜"用户想的是哪个时区"）。
    }
  }
}
