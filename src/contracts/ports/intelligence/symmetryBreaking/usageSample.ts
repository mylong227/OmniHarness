/** 单次使用样本。 */
export interface UsageSample {
  /** 能力标识。 */
  readonly capability: string;
  /** 使用权重（经验密度贡献）。 */
  readonly weight: number;
}
