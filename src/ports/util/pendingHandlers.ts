/** 一条在途请求的收尾通道；`reject` 缺省表示该站点只关心成功路径。 */
export interface PendingHandlers<T> {
  /** 兑现该请求。 */
  readonly resolve: (value: T) => void;
  /** 失败该请求（缺省时失败路径只做清理，不通知调用方）。 */
  readonly reject?: (error: Error) => void;
}
