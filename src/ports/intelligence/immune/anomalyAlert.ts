/** 异常告警。 */
export interface AnomalyAlert {
  /** 异常度（与自体分布的距离，越大越异常）。 */
  readonly score: number;
  /** 异常特征签名（用于记忆细胞二次加速响应）。 */
  readonly signature: string;
  /** 严重度。 */
  readonly severity: 'warn' | 'critical';
}
