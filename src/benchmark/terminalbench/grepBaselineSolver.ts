/**
 * 同预算 grep 竞品基线（B2）。
 *
 * 作为 OmniHarness 的公平对照：在**相同 maxToolCalls 预算**内，用 grep/findstr
 * 在**一次性应用目录**里检索任务名与分类，把命中文本累积为「答案」。
 * 它不真正解题，只衡量「纯检索基线」的天花板，使 OmniHarness 的增益可证伪
 * （若 OmniHarness 通过率不显著高于此基线，则无实质优势）。
 *
 * 检索范围是 `prepared.appDir` 而**不是**源任务目录：源目录只读，
 * 且基线必须与 OmniHarness 看到同一个环境，否则两者不可比。
 */
import type { Solver, SolverInput, SolverOutcome } from './types.js';

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
   * @param input 求解上下文（检索范围是 `input.prepared.appDir`，不是源任务目录）。
   * @returns 检索到的文本与消耗次数
   */
  public async solve(input: SolverInput): Promise<SolverOutcome> {
    const isWindows = process.platform === 'win32';
    const tool = isWindows ? 'findstr' : 'grep';
    const queries = [input.task.name, input.task.category, ...input.task.tags].filter(
      (q) => q !== '',
    );
    const scope = input.prepared.appDir;
    let budgetUsed = 0;
    let answer = '';
    for (const query of queries) {
      if (budgetUsed >= input.budget.maxToolCalls) {
        break;
      }
      budgetUsed += 1;
      const args = isWindows ? ['/s', '/i', '/n', query, scope] : ['-rni', query, scope];
      const out = await input.backend.runCommand([tool, ...args], scope);
      answer += out.stdout;
      if (out.stdout.length > 0) {
        answer += '\n';
      }
    }
    return { answer, budgetUsed };
  }
}
