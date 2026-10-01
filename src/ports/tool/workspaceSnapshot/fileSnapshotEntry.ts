/** 单文件快照条目。 */
export interface FileSnapshotEntry {
  /** 相对工作区根的路径。 */
  readonly relPath: string;
  /**
   * 回滚目标内容；`null` 表示该文件在快照时刻并不存在（会话中新建的未跟踪文件），
   * 回滚时应被删除。
   */
  readonly content: string | null;
}
