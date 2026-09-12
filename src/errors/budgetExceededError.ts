import { OmniError, ErrorCode } from '../omniError.js';

/**
 * 成本预算耗尽错误（#S29）：硬预算熔断时抛出，fail-closed 阻止后续模型调用。
 *
 * 从 `ports/model.ts` 迁出为独立模块（P1.3 端口纯化）：`src/ports/**` 只允许接口与纯类型，
 * 不得承载 `class` 实现。原路径 `ports/model.ts` 仍以 `export` 再导出本类，调用点零改动。
 */
export class BudgetExceededError extends OmniError {
  /** 预算上限（USD）。 */
  public readonly limitUsd: number;
  /** 已花费（USD）。 */
  public readonly spentUsd: number;
  /** 被阻断的模型名。 */
  public readonly model: string;

  /**
   * @param message 错误信息（透传给 `OmniError`）。
   * @param info 预算快照：上限、已花费、被阻断的模型名。
   */
  public constructor(
    message: string,
    info: { readonly limitUsd: number; readonly spentUsd: number; readonly model: string },
  ) {
    super(ErrorCode.BUDGET_EXCEEDED, message);
    this.limitUsd = info.limitUsd;
    this.spentUsd = info.spentUsd;
    this.model = info.model;
  }
}
