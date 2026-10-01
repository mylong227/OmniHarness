/**
 * 工作区快照端口：为检查点提供「文件级回滚」能力（对齐 Claude Code /rewind 的对话+代码双回滚）。
 *
 * 快照只捕获**会话触碰过的文件**（相对 HEAD 的工作树差异），而非整仓；回滚时手术式还原，
 * 不触碰无关文件，也不对整棵树执行 `git checkout`（符合沙箱安全铁律：禁用大规模 `git checkout -- .`）。
 */

export type { FileSnapshotEntry } from './workspaceSnapshot/fileSnapshotEntry.js';
export type { FileSnapshot } from './workspaceSnapshot/fileSnapshot.js';
export type { WorkspaceSnapshotPort } from './workspaceSnapshot/workspaceSnapshotPort.js';
