/** 检查点元信息。 */
export interface CheckpointMeta {
  readonly label: string;
  readonly ts: string;
  readonly eventCount: number;
  /** 是否包含文件级快照（可用于代码回滚）。 */
  readonly hasFileSnapshot: boolean;
}
