/** 提议写入的结果。 */
export interface OobleckWriteResult {
  /** 是否被接受（冻结后一律 false）。 */
  readonly accepted: boolean;
  /** 本次写入是否导致了冻结（冲击越过 τ）。 */
  readonly frozen: boolean;
  /** 拒绝原因。 */
  readonly reason?: 'frozen' | 'liquid' | 'yield';
}
