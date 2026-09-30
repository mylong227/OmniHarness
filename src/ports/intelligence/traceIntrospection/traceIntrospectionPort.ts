import type { TraceEntry } from './traceEntry.js';

/** 只读自省 trace 端口（无任何写方法）。 */
export interface TraceIntrospectionPort {
  readonly name: string;
  /**
   * 最近 k 条（新在前）。
   * @param k 返回条数上限（默认 20）
   * @returns 冻结的条目快照（深拷贝，调用方改动不影响源）
   */
  recent(k?: number): readonly TraceEntry[];
  /**
   * 按类别取最近 k 条（新在前）。
   * @param kind 事件类别
   * @param k 返回条数上限（默认 20）
   * @returns 冻结的条目快照
   */
  byKind(kind: string, k?: number): readonly TraceEntry[];
}
