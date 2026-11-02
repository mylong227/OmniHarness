import type { DelegateRequest, DelegateResult } from './a2aProtocol.ts';

/**
 * 任务处理器：A2A v1 与私有委托面共用的执行入口。
 *
 * `cancel` 可选：实现方若能按 taskId 中止执行（如 A2aTaskExecutor 会 abort 子代理），
 * `tasks/cancel` 会先调它再落 canceled 状态；未实现时仅改状态（流会在下一次更新时收敛）。
 */
export interface TaskHandler {
  /**
   * 执行一次委托任务。
   * @param request 委托请求（taskId / 输入 / 签名断言）。
   * @returns 任务执行结果。
   */
  handle(request: DelegateRequest): Promise<DelegateResult>;
  /**
   * 尝试取消一个在跑任务。
   * @param taskId 任务 id。
   * @returns 是否真的找到了在跑执行并发出取消。
   */
  cancel?(taskId: string): boolean;
}
