import type { LspRange } from './lspRange.js';

/**
 * @beta
 * 一个代码位置（已转回编辑器坐标，uri 为普通文件系统路径而非 file://）。
 */
export interface LspLocation {
  /** 文件系统绝对路径（适配器已把 file:// URI 转回）。 */
  readonly uri: string;
  /** 1-based 区间。 */
  readonly range: LspRange;
}
