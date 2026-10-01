/** 记忆退火一步的报告。 */
export interface AnnealStepReport {
  /** 第几步（从 1 起）。 */
  readonly step: number;
  /** 本步退火后的温度（调度状态）。 */
  readonly temperature: number;
  /** 参与重加权的事实数。 */
  readonly facts: number;
  /** 本步重要性总漂移（L1，所有事实 |Δimportance| 之和）。 */
  readonly drift: number;
  /** 本步「充能」事实数（T3.2 三态循环）：重要性上升（簇内共识增强）或被外部更新复活。 */
  readonly charged: number;
  /** 本步「衰减」事实数（T3.2 三态循环）：重要性下降但未触底（自然遗忘进行中）。 */
  readonly decayed: number;
  /** 本步「解离」事实数（T3.2 三态循环）：触底事实脱离耦合图（不再扩散收发），可经外部更新复活。 */
  readonly dissociated: number;
}
