/**
 * 工况信号（由运行时提取，交给 deriveRegime 映射为代数 Regime）。
 *
 * 已从 `genesis/operators.ts` 外迁到 ports/genesis：原文件退化为纯再导出桶，调用点零改动。
 * （同文件 `SparkEngines` 因引用大量 `adapters/*` 类型会触发 ports→adapters 被禁边，暂缓。）
 */
export interface RegimeSignals {
  readonly entropy: number;
  readonly modalityCount: number;
  /** 成本压力 ∈ [0,1]（spent/budget）。 */
  readonly costPressure: number;
  readonly successRate: number;
}
