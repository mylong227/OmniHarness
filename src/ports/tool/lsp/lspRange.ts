import type { LspPosition } from './lspPosition.js';

/**
 * @beta
 * 编辑器坐标系下的区间（1-based）。
 */
export interface LspRange {
  readonly start: LspPosition;
  readonly end: LspPosition;
}
