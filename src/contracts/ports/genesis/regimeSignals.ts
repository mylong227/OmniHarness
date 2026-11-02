/**
 * 工况信号（由运行时提取，交给 deriveRegime 映射为代数 Regime）。
 *
 * 已从 `genesis/operators.ts` 外迁到 ports/genesis：原文件退化为纯再导出桶，调用点零改动。
 * 同文件 `SparkEngines` 亦已外迁至 `ports/genesis/sparkEngines.ts`，字段统一为 ports 层引擎端口，
 * `ports→adapters` 禁边已解除（各引擎类均已 `implements` 对应端口）。
 */
export interface RegimeSignals {
  readonly entropy: number;
  readonly modalityCount: number;
  /** 成本压力 ∈ [0,1]（spent/budget）。 */
  readonly costPressure: number;
  readonly successRate: number;
}
