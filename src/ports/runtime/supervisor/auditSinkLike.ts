import type { AuditEvent } from '../../server/auditEvent.js';

/** 审计 sink 结构类型（与 `AuditSink` 兼容，零耦合、运行时无第三方依赖）。 */
export interface AuditSinkLike {
  record(entry: AuditEvent): number | undefined;
}
