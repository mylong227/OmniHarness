import type { TraceEntry } from './traceEntry.js';

/**
 * trace 读取结果：只读条目 + 计数 + 失败原因（fail-soft，不抛错给调用方）。
 */
export interface TraceReadResult {
  /** 目标会话 id（原样回显，便于多会话消费方对齐）。 */
  readonly session: string;
  /** 冻结的条目快照（新在前）。 */
  readonly entries: readonly TraceEntry[];
  /** 条目数（= entries.length，便于 RPC 消费方免解析）。 */
  readonly count: number;
  /** 失败原因（会话不存在 / 存档不可读等）；成功时 undefined。 */
  readonly error?: string | undefined;
}
