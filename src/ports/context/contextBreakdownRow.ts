import type { ContextCategoryKey } from '../model/model.js';

/** 单行分类占比。 */
export interface ContextBreakdownRow {
  /** 分类键。 */
  readonly key: ContextCategoryKey;
  /** 分类展示名（取自 CONTEXT_CATEGORIES）。 */
  readonly label: string;
  /** 该类估算 token 数。 */
  readonly tokens: number;
  /** 占**已用上下文**的百分比（0–100，一位小数）。与窗口占比是两回事：本字段各行之和不含余量。 */
  readonly percent: number;
}
