import type { FileSnapshotEntry } from './fileSnapshotEntry.js';

/** 工作区文件快照（可序列化）。 */
export interface FileSnapshot {
  /** 工作区根（用于校验，避免还原到错误目录）。 */
  readonly root: string;
  /** 会话触碰文件条目。 */
  readonly entries: readonly FileSnapshotEntry[];
}
