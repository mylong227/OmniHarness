/** 全量校验+纠正报告。 */
export interface QECReport {
  /** 校验的事实数。 */
  readonly checked: number;
  /** 被定位并纠正的数。 */
  readonly corrected: number;
  /** 无法纠正（多点 corrupt）的数。 */
  readonly uncorrectable: number;
}
