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
 * 默认并发上限。
 */
export const DEFAULT_MAX_CONCURRENCY = 4;

/**
 * @beta
 * 默认子智能体步数上限（独立于主会话 maxSteps，防单个子任务失控）。
 */
export const DEFAULT_SUBAGENT_MAX_STEPS = 12;

/**
 * @beta
 * 子智能体任务请求。
 */
export interface SubagentRequest {
  readonly task: string;
  readonly parentSessionId: string;
  readonly depth: number;
  /** 授权给子智能体的工具名；不传则继承父工具集（自动剔除 subagent）。 */
  readonly tools?: readonly string[];
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
}

/**
 * @beta
 * 子智能体编排参数。
 */
export interface SubagentOptions {
  readonly maxDepth?: number;
  readonly maxConcurrency?: number;
  /** 单个子智能体的步数上限。 */
  readonly maxSteps?: number;
}
