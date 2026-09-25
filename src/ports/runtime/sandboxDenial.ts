/**
 * 沙箱拒绝归因的**契约**（`RuntimeFailure` 形状）。
 *
 * 实现体（`SandboxDenial`，见 `src/security/sandboxDenial.ts`）于 2026-09-26 迁出 ports：
 * `src/ports/**` 的架构门禁禁止实现类（ports 只放契约与类型）。
 * 位置沿革：`adapters/sandbox/denial.ts` →（P1 解耦 `c9509ba`）本文件 → 实现迁出、本文件留契约。
 */

/** 运行时失败形状（兼容 child_process / node:fs 抛错）。 */
export interface RuntimeFailure {
  /** 退出码。 */
  readonly code?: string | number;
  /** 终止信号。 */
  readonly signal?: string | number;
  /** 标准错误输出。 */
  readonly stderr?: string;
  /** 错误消息。 */
  readonly message?: string;
}
