/**
 * Terminal-Bench 套件运行器（B2）。
 *
 * 编排：遍历任务目录 → 解析 → 可选 setup → Solver 求解 → run-tests.sh 判分 → 汇总写报告。
 * 解耦于具体后端与 Solver，使 OmniHarness 与 grep 基线走同一计分口径。
 */
import { existsSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ParallelMap } from '../../util/parallelMap.js';
import type {
  BenchmarkBudget,
  ContainerBackend,
  Solver,
  SuiteReport,
  TaskResult,
  TerminalBenchTask,
} from './types.js';
import { TaskParser } from './taskParser.js';

/** 单轮套件配置。 */
export interface SuiteConfig {
  /** Terminal-Bench tasks 根目录（其下每子目录为一个任务）。 */
  readonly tasksRoot: string;
  /** 容器后端。 */
  readonly backend: ContainerBackend;
  /** Solver（OmniHarness 或 grep 基线）。 */
  readonly solver: Solver;
  /** 预算约束。 */
  readonly budget: BenchmarkBudget;
  /** 报告写出路径。 */
  readonly reportPath: string;
  /**
   * 并发上限（默认 1=严格串行）。任务目录相互独立，N>1 时走有界均衡并行以突破串行墙钟；
   * 结果**严格同序**（与任务目录顺序一致）。须与后端承载匹配（本地容器内存/端口）。
   */
  readonly concurrency?: number;
}

/** Terminal-Bench 套件运行器（纯静态编排）。 */
export class TerminalBenchRunner {
  private constructor() {}

  /**
   * 运行整套任务并写出报告。
   *
   * @param config 套件配置
   * @returns 汇总报告
   */
  public static async run(config: SuiteConfig): Promise<SuiteReport> {
    const taskDirs = TerminalBenchRunner.listTasks(config.tasksRoot);
    const runner = new ParallelMap(config.concurrency ?? 1);
    const results: readonly TaskResult[] = await runner.map(taskDirs, (dir) => {
      const task = TaskParser.parse(dir);
      return TerminalBenchRunner.runOne(task, config.backend, config.solver, config.budget);
    });
    const passed = results.filter((r) => r.passed).length;
    const report: SuiteReport = {
      solver: config.solver.name,
      total: results.length,
      passed,
      passRate: results.length === 0 ? 0 : passed / results.length,
      results,
    };
    writeFileSync(config.reportPath, JSON.stringify(report, null, 2), 'utf8');
    return report;
  }

  /**
   * 运行单个任务：setup → solve → test。
   *
   * @param task 任务
   * @param backend 容器后端
   * @param solver Solver
   * @param budget 预算
   * @returns 单任务结果
   */
  private static async runOne(
    task: TerminalBenchTask,
    backend: ContainerBackend,
    solver: Solver,
    budget: BenchmarkBudget,
  ): Promise<TaskResult> {
    const start = Date.now();
    try {
      if (task.setupScript !== null) {
        await backend.runCommand(['bash', task.setupScript], task.taskDir);
      }
      const outcome = await solver.solve(task, backend, budget);
      const test = await backend.runCommand(['bash', task.testScript], task.taskDir);
      const passed = test.exitCode === 0;
      return {
        task: task.name,
        solver: solver.name,
        passed,
        budgetUsed: outcome.budgetUsed,
        durationMs: Date.now() - start,
        error: passed ? null : `run-tests.sh 退出码 ${test.exitCode}`,
      };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return {
        task: task.name,
        solver: solver.name,
        passed: false,
        budgetUsed: 0,
        durationMs: Date.now() - start,
        error: message,
      };
    }
  }

  /**
   * 列出含 task.yaml 的任务子目录。
   *
   * @param root tasks 根目录
   * @returns 任务目录绝对路径列表
   */
  private static listTasks(root: string): readonly string[] {
    if (!existsSync(root)) {
      throw new Error(`Terminal-Bench tasks 根目录不存在: ${root}`);
    }
    const entries = readdirSync(root);
    const dirs: string[] = [];
    for (const entry of entries) {
      const full = join(root, entry);
      let isDir = false;
      try {
        isDir = statSync(full).isDirectory();
      } catch {
        isDir = false;
      }
      if (isDir && existsSync(join(full, 'task.yaml'))) {
        dirs.push(full);
      }
    }
    return dirs;
  }
}
