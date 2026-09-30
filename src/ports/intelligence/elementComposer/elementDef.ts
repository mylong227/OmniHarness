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
