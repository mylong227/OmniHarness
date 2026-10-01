/** 取消原因分类（结构化，供 UI/日志/重试决策）。 */
export type CancelReason =
  | 'user' // 用户主动中断（Ctrl-C / 请求断开）
  | 'timeout' // wall-clock / 单步超时
  | 'loop-guard' // 失控检测熔断
  | 'shutdown' // 进程退出
  | 'parent' // 父令牌级联
  | { readonly custom: string };
