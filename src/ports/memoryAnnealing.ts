/**
 * 记忆退火端口（热方程记忆重加权 / 退火调度）。S+ 发明层知识基础算子。
 *
 * 把长期记忆建模为一张"事实图"：节点是记忆事实，边是它们之间的共振耦合
 * （复用燧-3 频率域共振度）。在图上跑离散热方程（扩散），让共振簇内重要性趋于
 * 共识、孤立事实自然消退；同时以温度调度 T(t) 控制重加权强度——高温时激进重排、
 * 低温时冻结，即"退火"。几何/向量范式在代数上不支持此算子（市面唯一）。
 */
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

/** 记忆退火器端口。 */
export interface MemoryAnnealer {
  readonly name: string;
  /** 跑一步退火重加权（离散热方程扩散 + 冷却 + 衰减）。返回本步报告。 */
  anneal(): AnnealStepReport;
  /** 当前温度（退火调度状态，随步数单调下降）。 */
  readonly temperature: number;
  /** 已跑步数。 */
  readonly steps: number;
}
