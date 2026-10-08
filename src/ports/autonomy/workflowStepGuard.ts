import type { WorkflowStepStatus } from './workflowStepStatus.js';

/**
 * 步骤的**受控执行条件**（`when`）：声明「仅当某个已依赖步骤处于某终态时才执行本步」。
 *
 * ## 与 LangGraph「条件边」的区别（必须说清，否则语义会被误用）
 *
 * - LangGraph 的条件边**改变图拓扑**（运行时决定下一步走哪个节点，图可以成环）；
 * - 本字段**不改变拓扑**：拓扑仍由 `dependsOn` 静态决定（分层/并发/判环全部不变），
 *   `when` 只决定**本步是否执行**。因此它带来「分支/补救」的表达力，
 *   而**不**带来图灵完备化——这正是本仓刻意保留的约束（环由 `WorkflowCycleError` 拒绝）。
 *
 * ## 硬约束（由 `WorkflowGuard.validate` fail-closed 强制）
 *
 * 1. `step` 必须是同一工作流里存在的步骤 id；
 * 2. `step` 必须出现在本步 `dependsOn` 中 —— 否则「观察某步的状态」这件事没有调度顺序保证，
 *    会出现「读到上一轮的陈旧状态」这种最难查的错误；
 * 3. 不得自引用；
 * 4. `status` 只允许 `done` / `failed` / `skipped`：`blocked` / `cancelled` 是**基础设施层**的
 *    传输态（上游失败、父取消），拿它当业务信号等于把故障当分支条件；
 * 5. `outputMatches` 必须能编译成正则（编译失败即拒绝启动，而不是运行期静默不匹配）。
 */
export interface WorkflowStepGuard {
  /** 被观察的步骤 id（必须同时出现在本步 `dependsOn` 中）。 */
  readonly step: string;
  /** 期望该步的终态。 */
  readonly status: Extract<WorkflowStepStatus, 'done' | 'failed' | 'skipped'>;
  /**
   * 可选：仅当被观察步骤的产出匹配此正则（JavaScript 正则字面量语义，`u` 标志未启用）时才执行。
   *
   * 仅在 `status === 'done'` 时有意义：`failed` / `skipped` 的步骤没有产出，
   * 声明它会被 `WorkflowGuard.validate` 判为规格错误（避免「永远不成立」的哑条件）。
   */
  readonly outputMatches?: string | undefined;
}
