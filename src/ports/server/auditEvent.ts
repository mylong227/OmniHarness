/**
 * @beta
 * 审计事件。
 */
export interface AuditEvent {
  readonly ts?: string | undefined;
  readonly type: string;
  readonly sessionId?: string | undefined;
  readonly actor?: string | undefined;
  readonly detail?: unknown | undefined;
  /** 链序号（从 1 开始递增）。仅哈希链写入后才有值。 */
  readonly seq?: number | undefined;
  /** 上一条记录哈希（首条为创世前驱）。 */
  readonly prev?: string | undefined;
  /** 本条哈希 = SHA256(prev ‖ canonical(本条))。 */
  readonly hash?: string | undefined;
}
