/** 单题答案。 */
export interface DecisionAnswer {
  /** `choice` 选中的类别。 */
  readonly choice?: string;
  /** `score` 的有序打分（如 0–2）。 */
  readonly score?: number;
  /** `noul`：「答案为是」的概率，区间 [0,1]。 */
  readonly noul?: number;
  /** 实现原始输出（透传，便于审计 / 调试）。 */
  readonly raw?: unknown;
}
