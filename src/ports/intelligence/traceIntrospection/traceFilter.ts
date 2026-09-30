/**
 * trace 读取过滤器（RPC 与 CLI 共用同一形状，保证两条入口语义一致）。
 */
export interface TraceFilter {
  /** 返回条数上限（缺省 20；实现侧钳到 [1, 500]）。 */
  readonly limit?: number | undefined;
  /** 事件类别过滤（缺省不过滤，即 recent 语义）。 */
  readonly kind?: string | undefined;
}
