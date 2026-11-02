/** LSP 的 1-based 位置（行/列均从 1 开始）。 */
export interface LspOneBasedPosition {
  /** 行号（1-based）。 */
  readonly line: number;
  /** 列号（1-based）。 */
  readonly character: number;
}

/**
 * LSP 位置坐标转换。
 *
 * LSP 协议用 0-based 行列，而本仓的工具结果面向用户/模型统一用 1-based。两个 normalizer
 * （符号 / 代码操作）都要做同一件事，收在这里避免各写一份后漂移。
 */
export class LspPosition {
  /**
   * 0-based 位置对象 → 1-based 位置。
   * @param raw 原始位置（未知形状）
   * @returns 转换后的位置；形状不合法为 null
   */
  public static toOneBased(raw: unknown): LspOneBasedPosition | null {
    if (raw === null || typeof raw !== 'object') return null;
    const position = raw as Record<string, unknown>;
    const line = position['line'];
    const character = position['character'];
    if (typeof line !== 'number' || typeof character !== 'number') return null;
    return { line: line + 1, character: character + 1 };
  }
}
