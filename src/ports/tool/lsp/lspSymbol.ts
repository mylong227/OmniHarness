import type { LspSymbolKind } from './lspSymbolKind.js';
import type { LspRange } from './lspRange.js';

/**
 * @beta
 * 文档内的一个符号（已把层级压平并按深度缩进名字）。
 */
export interface LspSymbol {
  /** 符号名；嵌套符号带前导缩进（每层两个空格），使层级在纯文本里可见。 */
  readonly name: string;
  /** 符号种类（人类可读）。 */
  readonly kind: LspSymbolKind;
  /** 所属文件系统绝对路径（URI 已转回）。 */
  readonly file: string;
  /** 1-based 区间。 */
  readonly range: LspRange;
}
