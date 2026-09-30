/** 单工具健康条目（健康向量的一项）。 */
export interface HealthEntry {
  /** 工具名。 */
  readonly tool: string;
  /** 健康分 0..1，1=完全健康（成功数 / 总数）。 */
  readonly health: number;
  /** 滑动窗口内失败次数。 */
  readonly failures: number;
  /** 滑动窗口内成功次数。 */
  readonly successes: number;
  /** 最近一次错误（若有）。 */
  readonly lastError?: string | undefined;
}
