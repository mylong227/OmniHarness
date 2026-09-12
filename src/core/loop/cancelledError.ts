/** 取消原因分类（结构化，供 UI/日志/重试决策）。 */
export type CancelReason =
  | 'user' // 用户主动中断（Ctrl-C / 请求断开）
  | 'timeout' // wall-clock / 单步超时
  | 'loop-guard' // 失控检测熔断
  | 'shutdown' // 进程退出
  | 'parent' // 父令牌级联
  | { readonly custom: string };

function describeReason(reason: CancelReason): string {
  return typeof reason === 'string' ? reason : reason.custom;
}

/** 取消异常：throwIfAborted 抛出，catch 侧可精确识别「取消」与一般错误。 */
export class CancelledError extends Error {
  /** 取消原因（结构化分类，供 catch 侧区分「取消」与一般错误并做重试/UI 决策）。 */
  public readonly reason: CancelReason;
  public constructor(reason: CancelReason) {
    super(reason === 'user' ? '已取消（用户中断）' : `已取消: ${describeReason(reason)}`);
    this.name = 'CancelledError';
    this.reason = reason;
  }
}
