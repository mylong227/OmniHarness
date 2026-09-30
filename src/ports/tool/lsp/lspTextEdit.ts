import type { LspRange } from './lspRange.js';

/**
 * @beta
 * 一处文本编辑（`WorkspaceEdit` 的最小投影）。
 */
export interface LspTextEdit {
  /** 目标文件系统绝对路径。 */
  readonly file: string;
  /** 1-based 区间。 */
  readonly range: LspRange;
  /** 替换文本。 */
  readonly newText: string;
}
