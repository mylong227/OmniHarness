/**
 * 工作区快照端口：为检查点提供「文件级回滚」能力（对齐 Claude Code /rewind 的对话+代码双回滚）。
 *
 * 快照只捕获**会话触碰过的文件**（相对 HEAD 的工作树差异），而非整仓；回滚时手术式还原，
 * 不触碰无关文件，也不对整棵树执行 `git checkout`（符合沙箱安全铁律：禁用大规模 `git checkout -- .`）。
 */

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

/** 工作区文件快照（可序列化）。 */
export interface FileSnapshot {
  /** 工作区根（用于校验，避免还原到错误目录）。 */
  readonly root: string;
  /** 会话触碰文件条目。 */
  readonly entries: readonly FileSnapshotEntry[];
}

/** 工作区快照端口。 */
export interface WorkspaceSnapshotPort {
  readonly name: string;
  /** 捕获当前工作树相对 HEAD 的差异（仅会话触碰的文件）。 */
  capture(root: string): Promise<FileSnapshot>;
  /** 将快照写回工作树（覆盖已存在文件；`content=null` 的条目删除对应文件）。 */
  restore(root: string, snapshot: FileSnapshot): Promise<void>;
}
