import type { TraceFilter } from './traceFilter.js';

/**
 * trace 读取查询（会话 + 过滤条件）。
 */
export interface TraceReadRequest extends TraceFilter {
  /** 目标会话 id（必填；空串表示「当前/最近会话」由实现方决定，缺省实现按未找到处理）。 */
  readonly session: string;
}
