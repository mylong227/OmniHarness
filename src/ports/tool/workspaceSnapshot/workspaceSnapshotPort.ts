import type { FileSnapshot } from './fileSnapshot.js';

/** 工作区快照端口。 */
export interface WorkspaceSnapshotPort {
  readonly name: string;
  /** 捕获当前工作树相对 HEAD 的差异（仅会话触碰的文件）。 */
  capture(root: string): Promise<FileSnapshot>;
  /** 将快照写回工作树（覆盖已存在文件；`content=null` 的条目删除对应文件）。 */
  restore(root: string, snapshot: FileSnapshot): Promise<void>;
}
