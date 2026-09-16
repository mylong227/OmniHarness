import type { CostBudget } from './costBudget.js';
import type { BudgetDegradeSignal } from '../../ports/model/budgetDegrade.js';

/**
 * `CostBudget` → `BudgetDegradeSignal` 的薄桥接适配器（P5 自动降档）。
 *
 * 把 `adapters/model` 的预算计量实现桥成 `ports` 层只读端口，使 `core` 消费者
 * （`StepContextBuilder`）只依赖端口类型、不触碰适配器（守住 `core → adapters` 架构红线）。
 *
 * 零依赖、fail-safe：构造时传入的 `CostBudget` 为 undefined（默认部署无预算）时，
 * `shouldDegrade` 恒返 false，消费点据此零行为变更。
 */
export class CostBudgetDegradeAdapter implements BudgetDegradeSignal {
  /** 被桥接的预算计量；undefined 时降级信号恒为假。 */
  private readonly budget: CostBudget | undefined;

  /**
   * @param budget 成本预算计量（#S29）；undefined（未配置 `costBudgetUsd`）时降级信号恒为假。
   */
  public constructor(budget: CostBudget | undefined) {
    this.budget = budget;
  }

  /**
   * 是否应降级检索预算。
   * @returns 软阈值已越过且尚未硬熔断时为 true；无预算 / 未越软阈值 / 已硬熔断时为 false。
   */
  public get shouldDegrade(): boolean {
    return this.budget?.degradeSuggested ?? false;
  }
}
