import { OmniError, ErrorCode } from '../omniError.js';

/**
 * 下游故障熔断开路错误（F3）：某条依赖连续失败达阈值后进入开路冷却期，
 * 期间对该依赖的调用被**立即拒绝**（fail-closed，不发起任何外部调用，不占用超时与重试预算）。
 *
 * 与 {@link BudgetExceededError}（成本熔断）语义互不覆盖：
 *  - 成本熔断保护的是「别继续花钱」（预算越限，不可逆）；
 *  - 本类保护的是「下游已经不可用，别再打」（连续失败后短路，冷却到期自动半开恢复）。
 * 二者可同时存在——一次调用先过预算门禁，再过故障熔断门禁。
 */
export class CircuitOpenError extends OmniError {
  /** 熔断器名（如 `model`），用于定位是哪条依赖被熔断。 */
  public readonly breaker: string;
  /** 开路起点毫秒时间戳（冷却期以此为基准计算）。 */
  public readonly openedAt: number;
  /** 抛出时刻距冷却结束还需等待的毫秒数（用于上层提示/退避）。 */
  public readonly retryAfterMs: number;

  /**
   * @param message 错误信息（透传给 `OmniError`）。
   * @param info 熔断快照：熔断器名、开路时刻、剩余冷却毫秒。
   */
  public constructor(
    message: string,
    info: { readonly breaker: string; readonly openedAt: number; readonly retryAfterMs: number },
  ) {
    super(ErrorCode.CIRCUIT_OPEN, message);
    this.breaker = info.breaker;
    this.openedAt = info.openedAt;
    this.retryAfterMs = info.retryAfterMs;
  }
}
