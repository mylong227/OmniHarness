/** `todo_write` 触发的待办快照条目。 */
export interface TodoSnapshotEntry {
  readonly content: string;
  readonly status: string;
}
