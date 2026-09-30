import type { QECReport } from './qecReport.js';
import type { QECStatus } from './qecStatus.js';

/** QEC 编码器端口。 */
export interface QECEncoderPort {
  readonly name: string;
  /** 为已写入的事实（重）编码：写入/刷新其二维奇偶症状。 */
  encode(id: string): void;
  /** 校验单条：ok / 可纠正(corrected) / 不可纠正(uncorrectable)。不擅自改写。 */
  verify(id: string): QECStatus;
  /** 纠正单条：仅当可纠正时写回修复，否则返回原状态（fail-closed）。 */
  repair(id: string): QECStatus;
  /** 全量校验+纠正：返回报告。 */
  repairAll(): QECReport;
}
