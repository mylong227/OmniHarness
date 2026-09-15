/**
 * 同预算 grep 竞品基线（B2）。
 *
 * 作为 OmniHarness 的公平对照：在**相同 maxToolCalls 预算**内，用 grep/findstr 在任务目录里
 * 检索任务名与分类，把命中文本累积为「答案」。它不真正解题，只衡量「纯检索基线」的天花板，
 * 使 OmniHarness 的增益可证伪（若 OmniHarness 通过率不显著高于此基线，则无实质优势）。
 */
import type {
  BenchmarkBudget,
  ContainerBackend,
  Solver,
  SolverOutcome,
  TerminalBenchTask,
} from './types.js';

/** 同预算 grep 基线 Solver。 */
export class GrepBaselineSolver implements Solver {
  /** 基线 Solver 名称（固定 grep-baseline）。 */
  public readonly name = 'grep-baseline';

  private constructor() {}

  /**
   * 创建 grep 基线实例。
   *
   * @returns 实例
   */
  public static create(): GrepBaselineSolver {
    return new GrepBaselineSolver();
  }

  /**
   * 在预算内检索并产出答案。
   *
   * @param task 任务
   * @param backend 容器后端
   * @param budget 预算约束
   * @returns 检索到的文本与消耗次数
   */
  public async solve(
    task: TerminalBenchTask,
    backend: ContainerBackend,
    budget: BenchmarkBudget,
  ): Promise<SolverOutcome> {
    const grepCmd = process.platform === 'win32' ? 'findstr' : 'grep';
    const queries = [task.name, ...task.categories];
    let budgetUsed = 0;
    let answer = '';
    for (const query of queries) {
      if (budgetUsed >= budget.maxToolCalls) {
        break;
      }
      budgetUsed += 1;
      const args =
        process.platform === 'win32'
          ? ['/s', '/i', '/n', query, task.taskDir]
          : ['-rni', query, task.taskDir];
      const out = await backend.runCommand([grepCmd, ...args], task.taskDir);
      answer += out.stdout;
      if (out.stdout.length > 0) {
        answer += '\n';
      }
    }
    return { answer, budgetUsed };
  }
}
