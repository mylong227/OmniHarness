import type { CancelReason } from '../../ports/core/cancelReason.js';

/** 取消原因分类（契约唯一声明见 `src/ports/core/cancelReason.ts`；此处为原路径再导出，调用点零改动）。 */
export type { CancelReason } from '../../ports/core/cancelReason.js';

/** 取消异常：throwIfAborted 抛出，catch 侧可精确识别「取消」与一般错误。 */
export class CancelledError extends Error {
  /** 取消原因（结构化分类，供 catch 侧区分「取消」与一般错误并做重试/UI 决策）。 */
  public readonly reason: CancelReason;
  public constructor(reason: CancelReason) {
    super(
      reason === 'user' ? '已取消（用户中断）' : `已取消: ${CancelledError.describeReason(reason)}`,
    );
    this.name = 'CancelledError';
    this.reason = reason;
  }

  /**
   * describeReason — module-level helper moved into CancelledError.
   * @param {CancelReason} reason - reason
   * @returns {string} - result
   */
  private static describeReason(reason: CancelReason): string {
    return typeof reason === 'string' ? reason : reason.custom;
  }
}
