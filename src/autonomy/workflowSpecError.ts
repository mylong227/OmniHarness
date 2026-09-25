import { OmniError, ErrorCode } from '../omniError.js';
import { ConcurrencyLimiter } from '../util/concurrencyLimiter.js';

/**
 * @beta
 * 工作流定义非法（入参校验 fail-closed）：如 `maxConcurrency` 非 ≥1 的整数。
 *
 * 存在的意义：非法并发上限会让工作流的并发闸门**永不放行**（调用方永久挂起，
 * 无异常、无日志、无法收尾）。本错误把「挂死」换成「带可执行信息的立即拒绝」。
 */
export class WorkflowSpecError extends OmniError {
  /**
   * @param message 面向调用方的可执行错误描述（应说明哪个字段非法、合法取值是什么）
   */
  public constructor(message: string) {
    super(ErrorCode.WORKFLOW_SPEC, message);
  }

  /**
   * 解析并校验工作流并发上限（缺省取兜底值；非法即抛 {@link WorkflowSpecError}）。
   * @param requested 本次运行显式声明的并发上限（可为 undefined＝取兜底值）
   * @param fallback 兜底上限（须已合法，如 DEFAULT_WORKFLOW_CONCURRENCY）
   * @returns 生效的并发上限（≥1 的整数）
   * @throws WorkflowSpecError 显式值非法（0 / 负数 / NaN / 非数字）时抛出
   */
  public static requireWorkflowConcurrency(requested: unknown, fallback: number): number {
    if (requested === undefined) {
      return fallback;
    }
    try {
      return ConcurrencyLimiter.requireConcurrencyLimit(requested, 'maxConcurrency');
    } catch (error) {
      throw new WorkflowSpecError(error instanceof Error ? error.message : String(error));
    }
  }
}
