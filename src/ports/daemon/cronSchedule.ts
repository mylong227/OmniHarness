/**
 * cron 调度端口（Wave A.5 依赖准入第一项 · `croner`）。
 *
 * ## 它解决什么（为什么不是「自己写 20 行就够」）
 *
 * 本仓原有的例程扩展（`src/daemon/routineScheduler.ts` 的 `expandField` + `isDue`）是**纯 UTC 字段匹配**：
 * 它把表达式的每个字段展开成集合，再看当前 UTC 时刻是否落在交集里。这有两个真实后果：
 *
 * 1. **表达不了时区**——「每天本地 9:00」在 UTC 匹配下会按 UTC 9:00 触发（本机宿主为 Asia/Shanghai 时差 8 小时）；
 * 2. **表达不了夏令时**——DST 跳变让某些本地时刻**不存在**（春季）或**出现两次**（秋季），
 *    正确处理需要 IANA 时区库与跳变规则，不是字段展开能覆盖的。
 *
 * 本端口把「求下次触发时刻」抽成可替换的能力：调用方只依赖接口，实现可换（`croner` → luxon+自研 → 诚实降级）。
 *
 * ## 失败语义（fail-closed，三类必须分得清）
 *
 * - **表达式非法** ⇒ `{ok:false, reason}`（可读原因，含实现方原文）；
 * - **时区名非法** ⇒ `{ok:false, reason}`；
 * - **表达式合法但永不匹配**（如 `0 0 30 2 *`）⇒ **不是错误**：`{ok:true, atMs:null}`。
 *   把「永不匹配」当异常处理会让调度器在合法配置上崩掉；把它当成功又会让调用方误以为有下次。
 *   故端口显式区分，调用方必须显式处理 `null`。
 */

/** 表达式/时区校验结论。 */
export type CronValidation =
  | { readonly ok: true; readonly normalized: string }
  | { readonly ok: false; readonly reason: string };

/** 求下次触发时刻的结论。 */
export type CronNextRun =
  | {
      /** 求值成功。 */
      readonly ok: true;
      /** 下次触发时刻（epoch ms）；**null = 该表达式永不匹配**（合法但无解，不是错误）。 */
      readonly atMs: number | null;
      /** 实际使用的时区（IANA 名）。 */
      readonly timezone: string;
    }
  | {
      /** 求值被拒（fail-closed）。 */
      readonly ok: false;
      /** 可读原因。 */
      readonly reason: string;
    };

/** cron 调度端口。 */
export interface CronSchedulePort {
  /**
   * 校验表达式（不执行）。
   * @param expression cron 表达式（5 段或 6 段）
   * @returns 校验结论（含归一化后的表达式）
   */
  validate(expression: string): CronValidation;
  /**
   * 求 `afterMs` 之后的下一次触发时刻。
   * @param expression cron 表达式
   * @param afterMs 起始时刻（epoch ms；须为有限数）
   * @param timezone IANA 时区名；**缺省由实现给确定性默认值（本仓实现为 `UTC`）**，不得用宿主本地时区
   * @returns 下次触发结论（见 {@link CronNextRun}）
   */
  nextRunAt(expression: string, afterMs: number, timezone?: string): CronNextRun;
}
