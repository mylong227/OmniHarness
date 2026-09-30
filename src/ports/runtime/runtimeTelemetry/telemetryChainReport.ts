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
