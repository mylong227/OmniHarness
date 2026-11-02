/** `todo_write` 触发的待办快照条目。 */
export interface TodoSnapshotEntry {
  readonly content: string;
  readonly status: string;
  /** 稳定 id（可选，供依赖引用）。 */
  readonly id?: string;
  /** 依赖的前置步骤 id（可选）。 */
  readonly dependsOn?: readonly string[];
}
