/**
 * 预算降级信号端口（P5 自动降档）。
 *
 * 只读端口：把「是否应降级检索预算」这一决策信号从 `adapters/model` 的 `CostBudget`
 * 计量实现中**解耦**出来，使 `core` 层（消费者 `StepContextBuilder`）无需 import 适配器
 * （`core → adapters` 违反架构门禁红线）。`CostBudget` 只产出信号、不自行改运行时旋钮，
 * 本端口即该信号的稳定契约。
 *
 * 降级意图：软阈值已越过、但硬预算尚未熔断时，上层应**收敛检索预算**（缩 repo-map fileK、
 * 关语义路）以直接压低 token 消耗，而非坐等硬熔断。信号本身不可逆（置位后持续为真），
 * 直至会话结束或硬预算熔断使其失效（`degradeSuggested` 在硬熔断后回落 false）。
 *
 * 缺省不构造：仅当配置 `costBudgetUsd` 正数时，装配层才把 `CostBudget` 桥成本端口注入；
 * 默认部署（无预算）恒为 undefined ⇒ 消费点读取 `?.shouldDegrade` 永远 false，零行为变更。
 */
export interface BudgetDegradeSignal {
  /**
   * 是否应降级检索预算。
   * @returns 软阈值已越过且尚未硬熔断时为 true；无预算 / 未越软阈值 / 已硬熔断时为 false。
   */
  readonly shouldDegrade: boolean;
}
