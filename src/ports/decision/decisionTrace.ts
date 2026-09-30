/**
 * 决策 trace 端口（Laya 战略线 · 校准/评估数据面）：把「System-1 预判 vs 真实结果」配对样本
 * 交给实现落盘，供离线 RLCD 温度校准与借鉴清单项（§34.7 ②③：模型路由 / 相关度裁剪 / 全工具选择）
 * 的训练使用。
 *
 * 六边形（ports 第三方-free）：仅定义记录契约，落盘 / 上报由 `adapters/**` 承载。
 *
 * fail-open 铁律：写入实现**不得**抛错阻断主流程——`record` 的异常由实现内部吞掉
 * （与决策引擎「质量信号非安全边界」取向一致）。
 */

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

/** 决策 trace 端口：消费一条配对样本。 */
export interface DecisionTracePort {
  /** 端口名。 */
  readonly name: string;

  /**
   * 记录一条决策 trace（fail-open：实现内部吞掉写入异常，绝不抛给调用方）。
   *
   * @param trace 配对样本。
   * @returns 无返回值。
   */
  record(trace: DecisionTrace): void;
}
