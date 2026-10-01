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
}
