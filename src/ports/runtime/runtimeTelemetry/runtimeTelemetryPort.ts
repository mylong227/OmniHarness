import type { RuntimeTelemetryInput } from './runtimeTelemetryInput.js';
import type { RuntimeObservation } from './runtimeObservation.js';
import type { TelemetryChainReport } from './telemetryChainReport.js';

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
