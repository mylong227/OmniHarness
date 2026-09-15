/** 异常告警。 */
export interface AnomalyAlert {
  /** 异常度（与自体分布的距离，越大越异常）。 */
  readonly score: number;
  /** 异常特征签名（用于记忆细胞二次加速响应）。 */
  readonly signature: string;
  /** 严重度。 */
  readonly severity: 'warn' | 'critical';
}

/** 免疫自检报告。 */
export interface ImmuneSelfReport {
  /** 自体模型训练样本数。 */
  readonly selfSize: number;
  /** 最近一次观测到的异常（无则 null）。 */
  readonly lastAnomaly: AnomalyAlert | null;
}

/**
 * 免疫异常监控端口（Immune Monitoring，I-P1-5）。S+ 发明层。
 *
 * 仿 Dasgupta 阴性选择：用正常行为样本训练"自体检测器"（估计各维均值/方差与容忍界），
 * 偏离自体分布即告警/隔离；同一签名二次出现时记忆细胞加速响应（更早、更低阈值）。
 * 告警经 AuditSink 入链（fail-closed：仅告警/标记，绝不擅自改写受监控状态）。
 *
 * 这是 Agent 行为监控与自修复触发的"市面唯一"机制——竞品靠规则阈值，这里靠学习型自体分布。
 */
export interface ImmuneMonitorPort {
  readonly name: string;
  /** 用正常行为样本训练自体检测器（Welford 在线估计均值/方差 + 容忍界）。 */
  train(sample: readonly number[]): void;
  /** 观察一个行为样本：偏离自体→返回告警（按签名记忆细胞加速）。 */
  observe(sample: readonly number[]): AnomalyAlert | null;
  /** 自检：返回当前自体模型规模与最近异常（接 AuditSink 告警）。 */
  selfCheck(): ImmuneSelfReport;
}
