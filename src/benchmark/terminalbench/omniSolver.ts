/**
 * OmniHarness 驱动 Solver（B2）。
 *
 * 把任务交给真实 Agent 流水线求解。真实 Agent 运行时通过 {@link AgentRunner} 注入，
 * 沙箱无 Agent 运行时，默认 fail-closed（提示改用注入了真实 runner 的自定义脚本）。
 */
import type {
  AgentRunner,
  BenchmarkBudget,
  ContainerBackend,
  Solver,
  SolverOutcome,
  TerminalBenchTask,
} from './types.js';

/** OmniHarness Agent 驱动 Solver。 */
export class OmniSolver implements Solver {
  /** Solver 名称（固定 omniharness）。 */
  public readonly name = 'omniharness';

  /** 注入的真实 Agent 运行时接缝。 */
  private readonly runAgent: AgentRunner;

  private constructor(runAgent: AgentRunner) {
    this.runAgent = runAgent;
  }

  /**
   * 创建 OmniSolver 实例。
   *
   * @param runAgent 真实 Agent 运行时接缝（必填）
   * @returns 实例
   */
  public static create(runAgent: AgentRunner): OmniSolver {
    return new OmniSolver(runAgent);
  }

  /**
   * 在预算内求解单任务。
   *
   * @param task 任务
   * @param backend 容器后端
   * @param budget 预算约束
   * @returns Agent 产出
   */
  public async solve(
    task: TerminalBenchTask,
    backend: ContainerBackend,
    budget: BenchmarkBudget,
  ): Promise<SolverOutcome> {
    const outcome = await this.runAgent({ task, backend, budget });
    return { answer: outcome.answer, budgetUsed: outcome.budgetUsed };
  }
}
