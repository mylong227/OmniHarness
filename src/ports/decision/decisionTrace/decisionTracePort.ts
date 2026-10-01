import type { DecisionTrace } from './decisionTrace.js';

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
