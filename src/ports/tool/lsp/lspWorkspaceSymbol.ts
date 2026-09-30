import type { LspSymbolKind } from './lspSymbolKind.js';
import type { LspRange } from './lspRange.js';

/**
 * @beta
 * 工作区内的一处符号（`workspace/symbol` 的结果条目）。
 *
 * 与 {@link LspSymbol} 的区别只在**语义**：文档符号按文件层级组织（`name` 带缩进），
 * 工作区符号是**跨文件的全局清单**，名字一律顶格（缩进无意义），多出来的
 * `container` 承载「它属于哪个类/模块」——正是模型判断「该跳哪个同名符号」的关键信息。
 */
export interface LspWorkspaceSymbol {
  /** 符号名（不带缩进：全局清单里层级由 `container` 表达）。 */
  readonly name: string;
  /** 符号种类（人类可读）。 */
  readonly kind: LspSymbolKind;
  /** 所属文件系统绝对路径（URI 已转回；服务器连 URI 都没给时回落 `workspace/symbol` 查询串）。 */
  readonly file: string;
  /**
   * 1-based 区间。
   *
   * 服务器只给了文件、没给区间时（LSP 3.17 允许）为**文件起点 1:1**——如实表示
   * 「知道在哪个文件，不知道具体位置」，而不是丢掉这条结果或编一个行号。
   */
  readonly range: LspRange;
  /** 容器名（所属类/模块/包），服务器未给或为空时省略。 */
  readonly container?: string | undefined;
}
