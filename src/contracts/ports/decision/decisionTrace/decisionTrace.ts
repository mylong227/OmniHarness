/** 一条配对 trace：预判（noul）与真实结果（测试是否通过）的关联样本。 */
export interface DecisionTrace {
  /** 会话 id（聚合用）。 */
  readonly sessionId: string;
  /** 触发自验证的工具名。 */
  readonly toolName: string;
  /** 生效模式：shadow（仅观测）/ enforce（回灌预判）。 */
  readonly mode: 'shadow' | 'enforce';
  /** Laya `noul` 预判「改动会过测试」的概率（[0,1]）；引擎不可用 / 退化时为 undefined。 */
  readonly noul: number | undefined;
  /** 决策引擎是否可用。 */
  readonly available: boolean;
  /** 真实测试是否实际跑过（受预算 / 冷却约束可能未跑）。 */
  readonly testRan: boolean;
  /** 真实测试是否通过（testRan=false 时为 undefined）。 */
  readonly testPassed: boolean | undefined;
  /** 真实测试退出码（testRan=false 时为 undefined）。 */
  readonly testExitCode: number | undefined;
  /** 事件时间戳（epoch ms）。 */
  readonly at: number;
}
