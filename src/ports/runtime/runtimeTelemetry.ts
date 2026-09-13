/**
 * 长期运行遥测端口（I-P4-3 回填基座）。
 *
 * 设计意图：把"长期运行数据"做成**真实可采集、防篡改、可复跑**的基座，而非一次性报告。
 * 每条观测带 `seq`/`prev`/`hash` 哈希链（语义同 `AuditSink`），使中间条目被删/插/改均可检出。
 *
 * 铁律：
 * - 零运行时依赖（仅 Node 内置 `node:fs` / `node:crypto`）。
 * - 数据来源显式标注（`provenance`）：production=真实负载 / seed-bootstrap=已有诚实证据回填 / synthetic-lab=离线仿真。
 *   收紧算法**只认 production**，绝不拿 bootstrap/lab 数据当"真实负载"去调参——这是诚实边界。
 */

/** 数据来源：真实负载 / 已有诚实证据回填 / 离线仿真。 */
export type TelemetryProvenance = 'production' | 'seed-bootstrap' | 'synthetic-lab';

/** 观测种类。 */
export type TelemetryKind = 'cycle' | 'benchmark' | 'selfcheck' | 'backfill-seed';

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

/** 哈希链校验结果（与 `AuditSink` 同语义）。 */
export interface TelemetryChainReport {
  /**
   * 链完整性：
   * - `true`：完整未被篡改；
   * - `false`：被篡改；
   * - `null`：旧格式未启用哈希链，不可验证（不等于被篡改）。
   */
  readonly ok: boolean | null;
  /** 参与校验的条目数。 */
  readonly count: number;
  /** 首个断裂处 seq（ok=false 时有值）。 */
  readonly brokenAt?: number;
  /** 断裂原因（ok=false 时有值）。 */
  readonly reason?: string;
}

/** 记录输入：`ts` 可选（未提供时由 sink 生成当前时间）。 */
export type RuntimeTelemetryInput = Omit<RuntimeObservation, 'seq' | 'prev' | 'hash' | 'ts'> & {
  /** ISO 时间戳（可选，缺省由 sink 生成）。 */
  readonly ts?: string;
};

/** 长期运行遥测端口：append-only 落盘 + 哈希链防篡改。 */
export interface RuntimeTelemetryPort {
  readonly name: string;
  /** 记录一条观测（落盘 + 入链）。返回链序号；未配置目标时返回 undefined（no-op）。 */
  record(obs: RuntimeTelemetryInput): number | undefined;
  /** 读取全部观测。 */
  read(): readonly RuntimeObservation[];
  /** 校验哈希链完整性。 */
  verify(): TelemetryChainReport;
}
