/**
 * shell 工具族的**共用超时口径**（审计 §3.5「shell 工具族常量各自声明」的收口）。
 *
 * 为什么单独成模块：`ShellTool` 与 `ShellInteractiveTool` 各自声明了自己的 `MIN_TIMEOUT_MS`，
 * 值都是 `1000`——同族工具的下限本应一致（1s 以下会把正常命令误判为超时），
 * 但两处字面量各写一遍，改一处就会让两族行为分叉。此处收成一处，两个工具都引用它。
 *
 * **刻意不合并的**：两者的「默认/上限」语义不同，保持各自声明并附理由——
 * - `ShellTool`：调用方**必须**给 `timeout_ms`，其 `DEFAULT_MAX_TIMEOUT_MS` 是**钳制上界**（默认 10 分钟）；
 * - `ShellInteractiveTool`：有**默认超时**（10 分钟，用户可不传）与**更大的上限**（1 小时，
 *   交互式会话天然更久）。把这两个数字强行统一会改变其中一族的语义。
 */

/** 前台/后台/交互式 shell 共用的最小超时（毫秒）：低于此值会把正常命令误判为超时。 */
export const SHELL_MIN_TIMEOUT_MS = 1_000;

/** 前台 shell 的默认钳制上界（毫秒，10 分钟）。 */
export const SHELL_DEFAULT_MAX_TIMEOUT_MS = 600_000;

/** 交互式 PTY 的默认超时（毫秒，10 分钟；不传 `timeout_ms` 时生效）。 */
export const SHELL_INTERACTIVE_DEFAULT_TIMEOUT_MS = 600_000;

/** 交互式 PTY 的钳制上界（毫秒，1 小时；交互式会话天然更久）。 */
export const SHELL_INTERACTIVE_MAX_TIMEOUT_MS = 3_600_000;
