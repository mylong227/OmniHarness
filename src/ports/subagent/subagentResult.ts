import type { SessionEvent } from '../runtime/event.js';

/**
 * @beta
 * 子智能体执行结果。
 *
 * 已从 `subagent/subagentTypes.ts` 外迁到 ports/subagent：原文件退化为纯再导出桶，调用点零改动。
 */
export interface SubagentResult {
  readonly ok: boolean;
  readonly sessionId: string;
  readonly output: string;
  readonly steps: number;
  readonly durationMs: number;
  readonly depth: number;
  /** 失败原因（ok 为 false 时非空）。 */
  readonly error?: string;
  /** 子会话完整轨迹（由事件桥收集，不污染父观测流）。 */
  readonly events: readonly SessionEvent[];
  /**
   * 是否**未做完**（步数耗尽或失控熔断）。
   *
   * 存在理由（2026-09-26 审计 F10）：原先 `ok` 恒为 true，被截断的子任务以「成功 + 兜底摘要」
   * 上报父级，父级无法区分「完成」与「跑满步数」——这正是任务拆解里最有害的一类假信号。
   */
  readonly truncated?: boolean | undefined;
  /** 是否因失控熔断 / 取消而中断。 */
  readonly aborted?: boolean | undefined;
  /**
   * 子代理在**隔离工作树**里改动的文件（相对工作区路径，含新建文件）。
   *
   * 存在理由（2026-10-03 第六轮修看板 §8.1）：子代理的写入原先落在隔离工作树里，而清理是
   * `git worktree remove --force` **+ `git branch -D`** ⇒ 改动**静默消失**，父代理却收到 `ok:true`。
   * 现在清理**之前**把改动采集为 patch 工件，并把事实显式回传（缺省/空数组＝无改动）。
   */
  readonly changedFiles?: readonly string[] | undefined;
  /** 改动 patch 的落盘路径（工作区相对路径，可直接 `git apply`）。 */
  readonly patchPath?: string | undefined;
  /** patch 字节数（`patchTruncated` 为 true 时只是前一段的字节数）。 */
  readonly patchBytes?: number | undefined;
  /** patch 是否因超上限被截断（`changedFiles` 仍完整）。 */
  readonly patchTruncated?: boolean | undefined;
  /**
   * 采集改动**失败**（改动确实存在但取不回来）——**显式标记，绝不静默**。
   *
   * 这是本组字段的 fail-closed 兜底：即使 patch 采集/落盘失败，父级也必须知道"子代理改过东西
   * 而那些改动不可取回"，而不是看到一个干净的 `ok:true`。
   */
  readonly writesUnrecoverable?: boolean | undefined;
  /**
   * 本次子代理在**无 git 隔离**（copy 降级档）下运行 ⇒ 写类工具已被**禁用**（fail-closed）。
   *
   * 为什么禁写而不是照旧放行：copy 模式下改动落在临时拷贝目录，`cleanup()` 直接删目录且**没有 git 可比**
   * ⇒ 改动不可能取回。禁写是唯一不制造"静默丢失"的选择；子代理能用的工具因此少一部分，
   * 父级据本字段可解释"为什么它说改不了代码"。
   */
  readonly writesForbidden?: boolean | undefined;
}
