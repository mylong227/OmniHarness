import type { TelemetryKind } from './telemetryKind.js';
import type { TelemetryProvenance } from './telemetryProvenance.js';

/** 单条长期运行观测。 */
export interface RuntimeObservation {
  /** 观测唯一 id（未提供时由 sink 生成）。 */
  readonly id: string;
  /** ISO 时间戳。 */
  readonly ts: string;
  /** 观测种类。 */
  readonly kind: TelemetryKind;
  /** 算子 / 子系统标识，如 `confinement` / `oobleck` / `heatAnnealer` / `evolutionGate` / `spark-controller` / `suite`。 */
  readonly operator: string;
  /** 与参数收紧相关的配置快照子集（不含密钥 / 内容）。 */
  readonly configSnapshot: Readonly<Record<string, unknown>>;
  /** 实测指标（数值），用于后续统计与收紧判定。 */
  readonly metrics: Readonly<Record<string, number>>;
  /** 运维裁决：pass / fail / constrained。 */
  readonly verdict?: 'pass' | 'fail' | 'constrained';
  /** 数据来源（诚实边界：收紧算法只认 production）。 */
  readonly provenance: TelemetryProvenance;
  /** 哈希链序号（从 1 递增，写入后才有值）。 */
  readonly seq?: number;
  /** 上一条记录哈希（首条为创世前驱）。 */
  readonly prev?: string;
  /** 本条哈希 = SHA256(prev ‖ canonical(本条))。 */
  readonly hash?: string;
}
