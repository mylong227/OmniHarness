/**
 * @beta
 * 审计导出查询条件（全字段可选；未给则不过滤）。
 */
export interface AuditQuery {
  /** 时间下界（含），ISO 字符串；按字典序比较（ISO 时间可字典序排序）。 */
  readonly since?: string | undefined;
  /** 时间上界（含），ISO 字符串。 */
  readonly until?: string | undefined;
  /** 事件类型精确匹配。 */
  readonly type?: string | undefined;
  /** 会话 ID 精确匹配。 */
  readonly session?: string | undefined;
  /** 操作者精确匹配。 */
  readonly actor?: string | undefined;
  /** 最多返回条数（截尾取最近 N 条）。 */
  readonly limit?: number | undefined;
}
