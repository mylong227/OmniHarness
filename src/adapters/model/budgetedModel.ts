import type { ModelOutput, ModelPort, ModelRequest, StreamCallbacks } from '../../ports/model.js';
import type { CostBudget } from './costBudget.js';

/**
 * @beta
 * 成本预算装饰器（#S29）：fail-closed 包裹任意 `ModelPort`。
 *
 * - 调用前 `ensureWithin` 校验预算：已熔断则抛 `BudgetExceededError`，阻断支出；
 * - 调用成功后按返回的 `usage` 记账（无 usage 则不计入，绝不臆造成本）。
 *
 * 与 `RetryingModel` 串联时置于**外层**（先判预算再重试），确保重试不致重复记账，
 * 且预算熔断优先于重试退避（熔断后不再发起任何网络调用）。
 */
export class BudgetedModel implements ModelPort {
  public readonly name: string;

  public constructor(
    private readonly inner: ModelPort,
    private readonly budget: CostBudget,
  ) {
    this.name = inner.name;
  }

  public async generate(request: ModelRequest): Promise<ModelOutput> {
    this.budget.ensureWithin(this.inner.name);
    const out = await this.inner.generate(request);
    if (out.usage !== undefined) {
      this.budget.record(this.inner.name, out.usage);
    }
    return out;
  }

  public async stream(request: ModelRequest, callbacks: StreamCallbacks): Promise<ModelOutput> {
    this.budget.ensureWithin(this.inner.name);
    const out =
      this.inner.stream !== undefined
        ? await this.inner.stream(request, callbacks)
        : await this.inner.generate(request);
    if (out.usage !== undefined) {
      this.budget.record(this.inner.name, out.usage);
    }
    return out;
  }
}
