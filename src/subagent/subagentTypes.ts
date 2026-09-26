import type { SessionEvent } from '../ports/runtime/event.js';

/**
 * @beta
 * 子智能体工具名（需在子代工具集中剔除，防进程内递归）。
 */
export const SUBAGENT_TOOL_NAME = 'subagent';

/**
 * @beta
 * 默认最大派生深度（1 = 主会话，2 = 允许一层子智能体）。
 */
export const DEFAULT_MAX_DEPTH = 2;

/**
 * @beta
 * 默认并发上限（**单一来源**：`SubagentOrchestrator` 直接引用本常量，不再自留一份）。
 *
 * 口径更正（2026-09-26 审计 F19）：本常量原为 4 且**无人引用**，而编排器自留了一份 16 ——
 * 「文档写的默认」与「真实默认」长期不一致。现按事实统一为 16（成熟产品量级，可被 config 覆盖）。
 */
export const DEFAULT_MAX_CONCURRENCY = 16;

/**
 * @beta
 * 默认子智能体步数上限（独立于主会话 maxSteps，防单个子任务失控）。
 */
export const DEFAULT_SUBAGENT_MAX_STEPS = 12;

/**
 * @beta
 * 父会话取消时的统一失败文案（子代理 / 工作流 / 目标循环共用，便于调用侧识别「是取消」）。
 */
export const CANCELLED_BY_PARENT_MESSAGE = '已取消：父会话已取消，子代不再继续（未派生子智能体）';

/**
 * @beta
 * 子智能体任务请求。
 */
export interface SubagentRequest {
  readonly task: string;
  readonly parentSessionId: string;
  readonly depth: number;
  /** 授权给子智能体的工具名；不传则继承父工具集（自动剔除 subagent）。 */
  readonly tools?: readonly string[] | undefined;
  /**
   * 父会话取消信号（可选）：已取消则不派生；派生后在飞模型请求随父取消一并中止。
   * 缺省 undefined＝不传播取消（库调用方自行决定）。
   */
  readonly signal?: AbortSignal | undefined;
}

/**
 * @beta
 * 子智能体执行结果。
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

/**
 * @beta
 * 子智能体编排参数。
 */
export interface SubagentOptions {
  readonly maxDepth?: number | undefined;
  readonly maxConcurrency?: number | undefined;
  /** 单个子智能体的步数上限。 */
  readonly maxSteps?: number | undefined;
}
