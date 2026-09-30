/**
 * @beta
 * 编辑器坐标系下的单点位置（1-based 行/列，与用户/模型所见一致）。
 */
export interface LspPosition {
  /** 行（从 1 开始）。 */
  readonly line: number;
  /** 列（从 1 开始）。 */
  readonly character: number;
}
