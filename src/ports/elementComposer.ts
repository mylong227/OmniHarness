/**
 * I-P3-2 元素组合基元（Periodic Table Primitives）端口。
 *
 * 真原创计算原语（燧-核·元素周期表）：用**有限基元集**（元素周期表）组合出多样能力。
 * 每个元素有化学价(valence)，组合合法 = 价互补(valence 相加为 0)，否则 fail-closed 拒绝。
 * 表达力远超"硬编码能力清单"——能力是**组合代数**的产物，有限基元涌现无限组合。
 *
 * fail-closed：未知元素 → 抛错（配置错误）；价不互补 → 返回 undefined（组合不合法）。
 */

/** 周期表中的一个元素基元。 */
export interface ElementDef {
  /** 元素符号（如 'Na' / 'Cl'）。 */
  readonly symbol: string;
  /** 族（如 'alkali' / 'halogen' / 'noble'）。 */
  readonly group: string;
  /** 化合价（整数群元素；互补 = 两价相加为 0）。 */
  readonly valence: number;
  /** 该基元携带的能力标签。 */
  readonly tags: readonly string[];
}

/** 由元素组合出的复合能力。 */
export interface CompoundCapability {
  /** 复合符号（元素符号拼接，如 'NaCl'）。 */
  readonly symbol: string;
  /** 参与组合的元素符号序列。 */
  readonly elements: readonly string[];
  /** 合并后的能力标签。 */
  readonly tags: readonly string[];
}

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
