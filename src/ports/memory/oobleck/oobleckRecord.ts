/** 非牛顿固化存储记录。 */
export interface OobleckRecord {
  /** 当前值。 */
  readonly value: string;
  /** 是否已冻结（rig>=1）。 */
  readonly frozen: boolean;
  /** 该存储实例的屈服应力阈值。 */
  readonly yieldStress: number;
}
