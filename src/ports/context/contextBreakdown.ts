import type { ContextBreakdownRow } from './contextBreakdownRow.js';

/** 估算结果。 */
export interface ContextBreakdown {
  /** 上下文窗口 token 数。 */
  readonly windowTokens: number;
  /** 已用 token 数（各行之和）。 */
  readonly usedTokens: number;
  /** 已用占窗口百分比（0–100，一位小数）。 */
  readonly percent: number;
  /** 分类明细（按 CONTEXT_CATEGORIES 顺序，含 0 值行）。 */
  readonly rows: readonly ContextBreakdownRow[];
  /** MCP 工具条数（诊断用）。 */
  readonly mcpToolCount: number;
  /** 系统工具条数（诊断用）。 */
  readonly systemToolCount: number;
}
