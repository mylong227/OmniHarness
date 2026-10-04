/**
 * `CronSchedulePort` 的 croner 实现（Wave A.5 · 依赖准入第一项）。
 *
 * ## 为什么引入第三方而不是继续自研（D10「必要且更优」的证据）
 *
 * 自研的 `RoutineScheduler.matchesCron` 用**宿主本地时区**的 `getHours/getDate/getDay` 做字段匹配
 * （2026-10-04 实测确认；其文件头一度误写成 UTC，已改正）：它**无法**回答「按 IANA 时区，
 * 下一次本地 9:00 是哪个瞬时」，而且连「在哪台机器上跑」都会改变触发时刻——后半句比「缺功能」更糟，
 * 属可复现性缺陷（CODE_STANDARD §12.1-5）。正确处理需要时区数据库 + DST 跳变/重叠规则
 * （春季跳变让 02:30 **不存在**，秋季让它**出现两次**）。实测 croner 在 `America/New_York` 的
 * `30 2 * * *` 上把不存在的那次正确顺延到 03:30 EDT。
 *
 * ## 三条生产级纪律（不是「装上就行」）
 *
 * 1. **缺省时区恒为 `UTC`，绝不用宿主本地**：croner 自身的默认是宿主本地时区，而宿主时区是**环境相关**的
 *    （本机实测为 `Asia/Shanghai`）——同一份配置在不同机器上触发时刻不同，这是可复现性缺陷（CODE_STANDARD §12.1-5）。
 *    故本实现把默认钉死为 `UTC`，要本地时间必须显式传时区。
 * 2. **编译结果有界缓存**：表达式每次 tick 都要编译，故缓存实例；缓存**有硬上限**（超出按插入序淘汰），
 *    避免表达式来源多样时无界增长（§12.1-3）。
 * 3. **失败面三类分明**：表达式非法 / 时区名非法 ⇒ `ok:false` + 可读原因；合法但永不匹配 ⇒ `atMs:null`。
 *    另对 `afterMs` 做边界校验（非有限数直接拒），不让 `NaN` 静默变成「没有下次」。
 *
 * @maturity L1 — DST 顺延 / 时区语义 / 三类失败语义 / 缓存上限 判据钉死
 * @maturityEvidence tests/unit/cronerSchedule.test.ts
 */
import { Cron } from 'croner';
import type {
  CronNextRun,
  CronSchedulePort,
  CronValidation,
} from '../../ports/daemon/cronSchedule.js';

/** 编译缓存硬上限（超出按插入序淘汰）。 */
const MAX_CACHE_ENTRIES = 128;

/** 装配项。 */
export interface CronerScheduleOptions {
  /**
   * 缺省时区（IANA 名）。
   *
   * **默认 `UTC`**：宿主本地时区是环境相关的，做默认值会让同一配置在不同机器上行为不同
   * （croner 自身的默认正是宿主本地——本机实测为 `Asia/Shanghai`）。
   */
  readonly defaultTimezone?: string | undefined;
}

/** croner 实现的 cron 调度（端口实现，唯一接触第三方的一层）。 */
export class CronerSchedule implements CronSchedulePort {
  /** 缺省时区（只读，供组合根与判据核对「默认不是宿主本地」）。 */
  public readonly defaultTimezone: string;
  /** 编译实例缓存（`timezone\u0000expression` → Cron；有界）。 */
  private readonly cache = new Map<string, Cron>();

  /**
   * @param opts 缺省时区（缺省 `UTC`）
   */
  public constructor(opts: CronerScheduleOptions = {}) {
    this.defaultTimezone = opts.defaultTimezone ?? 'UTC';
  }

  /**
   * 校验表达式（不执行）。
   * @param expression cron 表达式（5 段或 6 段）
   * @returns 校验结论（含归一化表达式）
   */
  public validate(expression: string): CronValidation {
    const normalized = expression.trim().replace(/\s+/g, ' ');
    if (normalized === '') {
      return { ok: false, reason: 'cron 表达式为空' };
    }
    try {
      // 只编译不排程：构造即为校验（croner 在非法格式上抛 CronPattern 错误）。
      this.compile(normalized, this.defaultTimezone);
      return { ok: true, normalized };
    } catch (err) {
      return { ok: false, reason: CronerSchedule.reasonOf(err) };
    }
  }

  /**
   * 求 `afterMs` 之后的下一次触发时刻。
   * @param expression cron 表达式
   * @param afterMs 起始时刻（epoch ms；须为有限数）
   * @param timezone IANA 时区名；缺省用 {@link CronerSchedule.defaultTimezone}（`UTC`）
   * @returns 下次触发结论
   */
  public nextRunAt(expression: string, afterMs: number, timezone?: string): CronNextRun {
    const zone = timezone ?? this.defaultTimezone;
    if (!Number.isFinite(afterMs)) {
      return { ok: false, reason: `起始时刻不是有限数：${String(afterMs)}` };
    }
    const normalized = expression.trim().replace(/\s+/g, ' ');
    if (normalized === '') {
      return { ok: false, reason: 'cron 表达式为空' };
    }
    let job: Cron;
    try {
      job = this.compile(normalized, zone);
    } catch (err) {
      return { ok: false, reason: CronerSchedule.reasonOf(err) };
    }
    try {
      const next = job.nextRun(new Date(afterMs));
      // 合法但永不匹配（如 `0 0 30 2 *`）**不是错误**：如实回 null，由调用方决定语义。
      return { ok: true, atMs: next === null ? null : next.getTime(), timezone: zone };
    } catch (err) {
      return { ok: false, reason: CronerSchedule.reasonOf(err) };
    }
  }

  /**
   * 取（或编译并缓存）实例；缓存超出硬上限时按插入序淘汰最旧一项。
   * @param expression 归一化表达式
   * @param timezone IANA 时区名
   * @returns croner 实例
   * @throws 表达式或时区非法时抛错（由调用方转成 `ok:false`）
   */
  private compile(expression: string, timezone: string): Cron {
    const key = `${timezone}\u0000${expression}`;
    const hit = this.cache.get(key);
    if (hit !== undefined) return hit;
    const job = new Cron(expression, { timezone });
    if (this.cache.size >= MAX_CACHE_ENTRIES) {
      const oldest = this.cache.keys().next();
      if (!oldest.done) this.cache.delete(oldest.value);
    }
    this.cache.set(key, job);
    return job;
  }

  /**
   * 把第三方异常转成可读原因（保留原文以便定位，不吞细节）。
   * @param err 异常
   * @returns 原因文本
   */
  private static reasonOf(err: unknown): string {
    const message = err instanceof Error ? err.message : String(err);
    return `cron 调度被拒：${message}`;
  }
}
