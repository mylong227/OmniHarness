/** 一条只读 trace 条目。 */
export interface TraceEntry {
  /** 稳定序号（事件流内单调，重放定位用）。 */
  readonly seq: number;
  /** 事件时刻（ISO 8601）。 */
  readonly at: string;
  /** 事件类别（tool.call / turn.end / error 等发布方语义）。 */
  readonly kind: string;
  /** 单行摘要（人类可读，供 agent 自省与报告）。 */
  readonly summary: string;
}
