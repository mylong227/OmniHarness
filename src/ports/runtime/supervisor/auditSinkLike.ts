import type { AuditEvent } from '../../../server/services/auditSink.js';

/** 审计 sink 结构类型（与 `AuditSink` 兼容，零耦合、零运行时依赖）。 */
export interface AuditSinkLike {
  record(entry: AuditEvent): number | undefined;
}
