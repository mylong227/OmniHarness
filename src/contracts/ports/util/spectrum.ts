/** 一条归一化频谱：values 已 L2 归一化，长度 = bins。 */
export interface Spectrum {
  /** 频谱 bin 数（与 `RESONANCE_BINS` 同源，contextEngine / repoMapContext 共用）。 */
  readonly bins: number;
  /** 归一化后的频域幅值数组，长度 = bins。 */
  readonly values: number[];
}
