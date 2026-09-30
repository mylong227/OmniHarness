/** 由元素组合出的复合能力。 */
export interface CompoundCapability {
  /** 复合符号（元素符号拼接，如 'NaCl'）。 */
  readonly symbol: string;
  /** 参与组合的元素符号序列。 */
  readonly elements: readonly string[];
  /** 合并后的能力标签。 */
  readonly tags: readonly string[];
}
