/** 沿刻痕低阻导通的结果（分支路径即低阻通道）。 */
export interface EtchConduction {
  /** 命中的 trace ID。 */
  readonly traceId: string;
  /** query 与该 trace 的共振强度。 */
  readonly resonance: number;
  /** 沿刻痕导通的分支路径标签序列。 */
  readonly path: readonly string[];
}
