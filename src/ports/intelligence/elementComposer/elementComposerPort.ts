import type { CompoundCapability } from './compoundCapability.js';
import type { ElementDef } from './elementDef.js';

/** 元素组合基元端口。 */
export interface ElementComposerPort {
  readonly name: string;
  /** 元素周期表（有限基元集）。 */
  elements(): readonly ElementDef[];
  /** 两元素是否价互补（可组合）。 */
  compatible(a: string, b: string): boolean;
  /**
   * 组合基元：序列中相邻元素全部价互补 → 复合能力；任一不互补 → undefined（组合不合法）。
   * 单元素或无元素 → undefined（不构成"组合"）。
   * fail-closed：未知元素符号 → 抛错。
   */
  compose(symbols: readonly string[]): CompoundCapability | undefined;
}
