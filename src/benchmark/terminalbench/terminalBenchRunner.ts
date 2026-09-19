/**
 * Terminal-Bench 套件运行器（B2）。
 *
 * 编排：遍历任务目录 → 解析 → 准备一次性上下文 → 可选 setup → Solver 求解 → 判分
 * → 回收上下文 → 汇总写报告。解耦于具体后端、Solver 与判分器，
 * 使 OmniHarness 与 grep 基线走同一计分口径。
 *
 * 三条关键纪律（都是 2026-09-19 重写时补上的）：
 *  ① **执行只发生在一次性上下文里**，源任务目录全程只读（见 {@link ExecutionBackend} 的契约）。
 *  ② **环境失败与能力失败分账**：机器级不可用、准备失败、判分未真正启动，一律记 `envError`，
 *     计分时从分母剔除并单独报「有效解题率」——环境噪声不得伪装成「模型没做出来」。
 *  ③ **映射启用时强制串行**：容器内 `/app` 是全机唯一名字，后端会如实通告
 *     「必须串行」（{@link codeBackendRequiresSerial}），运行器据此压并发，
 *     而不是并发写同一个 `/app` 互相毁证据。
 */
import { existsSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ParallelMap } from '../../util/parallelMap.js';
import type {
  BenchmarkBudget,
  ExecutionBackend,
  JudgeOutcome,
  PreparedTask,
  Solver,
  SuiteReport,
  TaskJudge,
  TaskResult,
  TerminalBenchTask,
} from './types.js';
import { TaskParser } from './taskParser.js';

/** 单轮套件配置。 */
export interface SuiteConfig {
  /** Terminal-Bench tasks 根目录（其下每子目录为一个任务）。 */
  readonly tasksRoot: string;
  /** 执行后端。 */
  readonly backend: ExecutionBackend;
  /** Solver（OmniHarness 或 grep 基线）。 */
  readonly solver: Solver;
  /** 判分器（通常 `new PytestJudge(backend)`）。 */
  readonly judge: TaskJudge;
  /** 预算约束。 */
  readonly budget: BenchmarkBudget;
  /** 报告写出路径。 */
  readonly reportPath: string;
  /**
   * 并发上限（默认 1=严格串行）。任务目录相互独立，N>1 时走有界均衡并行以突破串行墙钟；
   * 结果**严格同序**。后端要求串行时（映射 `/app` 的后端）本值被压到 1。
   */
  readonly concurrency?: number | undefined;
  /** 只跑这些任务名（缺省全跑），用于抽样与复现单题。 */
  readonly onlyTasks?: readonly string[] | undefined;
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
    const taskDirs = TerminalBenchRunner.select(config);
    const unavailable = TerminalBenchRunner.backendUnavailableReason(config.backend);
    const concurrency = TerminalBenchRunner.codeBackendRequiresSerial(config.backend)
      ? 1
      : Math.max(1, config.concurrency ?? 1);
    const runner = new ParallelMap(concurrency);
    const results: readonly TaskResult[] = await runner.map(taskDirs, (dir) =>
      TerminalBenchRunner.runOne(
        TaskParser.parse(dir),
        config.backend,
        config.solver,
        config.judge,
        config.budget,
        unavailable,
      ),
    );
    const passed = results.filter((r) => r.passed).length;
    const envErrors = results.filter((r) => r.envError).length;
    const scored = results.length - envErrors;
    const report: SuiteReport = {
      solver: config.solver.name,
      backend: config.backend.name,
      judge: config.judge.name,
      platform: `${process.platform}/${process.arch}`,
      total: results.length,
      passed,
      passRate: results.length === 0 ? 0 : passed / results.length,
      envErrors,
      effectivePassRate: scored <= 0 ? 0 : passed / scored,
      envErrorReasons: TerminalBenchRunner.histogram(results),
      results,
    };
    writeFileSync(config.reportPath, JSON.stringify(report, null, 2), 'utf8');
    return report;
  }

  /**
   * 选定本轮要跑的任务目录。
   *
   * @param config 套件配置
   * @returns 任务目录绝对路径列表（字典序，保证报告可复算）
   */
  private static select(config: SuiteConfig): readonly string[] {
    const all = TerminalBenchRunner.listTasks(config.tasksRoot);
    const only = config.onlyTasks;
    if (only === undefined || only.length === 0) {
      return all;
    }
    return all.filter((dir) => only.includes(dir.split(/[\\/]/).pop() ?? ''));
  }

  /**
   * 运行单个任务：prepare → setup → solve → judge → teardown。
   *
   * @param task 任务
   * @param backend 执行后端
   * @param solver Solver
   * @param judge 判分器
   * @param budget 预算
   * @param unavailable 机器级不可用原因（非 null 时本任务直接记环境失败）
   * @returns 单任务结果
   */
  private static async runOne(
    task: TerminalBenchTask,
    backend: ExecutionBackend,
    solver: Solver,
    judge: TaskJudge,
    budget: BenchmarkBudget,
    unavailable: string | null,
  ): Promise<TaskResult> {
    const start = Date.now();
    if (unavailable !== null) {
      return TerminalBenchRunner.failure(task, solver.name, start, unavailable, true);
    }
    let prepared: PreparedTask;
    try {
      prepared = await backend.prepare(task);
    } catch (error) {
      return TerminalBenchRunner.failure(
        task,
        solver.name,
        start,
        `准备执行环境失败: ${TerminalBenchRunner.message(error)}`,
        true,
      );
    }
    try {
      const outcome = await solver.solve({ task, backend, budget, prepared });
      const judged = await judge.judge(task, prepared);
      if (judged.envError !== null) {
        return TerminalBenchRunner.failure(task, solver.name, start, judged.envError, true);
      }
      return {
        task: task.name,
        solver: solver.name,
        passed: judged.passed,
        envError: false,
        budgetUsed: outcome.budgetUsed,
        durationMs: Date.now() - start,
        error: judged.passed ? null : TerminalBenchRunner.describeFailure(judged),
      };
    } catch (error) {
      return TerminalBenchRunner.failure(
        task,
        solver.name,
        start,
        TerminalBenchRunner.message(error),
        false,
      );
    } finally {
      await backend.teardown(prepared);
    }
  }

  /**
   * 把判分失败转成一句人话。
   *
   * @param judged 判分结果
   * @returns 失败描述
   */
  private static describeFailure(judged: JudgeOutcome): string {
    const tail = judged.output
      .split('\n')
      .filter((line) => line.trim() !== '')
      .slice(-3)
      .join(' | ');
    const head = judged.timedOut ? '判分超时' : `判分退出码 ${judged.exitCode}`;
    return tail === '' ? head : `${head}：${tail}`;
  }

  /**
   * 构造一条失败结果。
   *
   * @param task 任务
   * @param solverName Solver 名
   * @param start 起始时间戳
   * @param error 失败原因
   * @param envError 是否属环境失败
   * @returns 单任务失败结果
   */
  private static failure(
    task: TerminalBenchTask,
    solverName: string,
    start: number,
    error: string,
    envError: boolean,
  ): TaskResult {
    return {
      task: task.name,
      solver: solverName,
      passed: false,
      envError,
      budgetUsed: 0,
      durationMs: Date.now() - start,
      error,
    };
  }

  /**
   * 统计环境失败原因分布。
   *
   * @param results 逐任务结果
   * @returns 原因 → 数量
   */
  private static histogram(results: readonly TaskResult[]): Readonly<Record<string, number>> {
    const out: Record<string, number> = {};
    for (const result of results) {
      if (!result.envError) {
        continue;
      }
      // 归一化：把「xxx: 具体细节」压成「xxx」，避免同一原因裂成几十个桶。
      const key = (result.error ?? '未说明').split(/[:：]/)[0]!.trim().slice(0, 60);
      out[key] = (out[key] ?? 0) + 1;
    }
    return out;
  }

  /**
   * 问后端「本机能不能跑」（可选能力，鸭子类型探测；未实现视为可用）。
   *
   * 为什么不放进 {@link ExecutionBackend} 接口：这是一个**可选**能力
   * （远程/托管后端天然没有「本机缺 uv」这回事），强制实现只会逼出空实现。
   *
   * @param backend 执行后端
   * @returns 不可用原因；可用时为 null
   */
  private static backendUnavailableReason(backend: ExecutionBackend): string | null {
    return TerminalBenchRunner.callOptional(backend, 'unavailableReason') ?? null;
  }

  /**
   * 问后端「是否必须串行」（可选能力，鸭子类型探测；未实现视为可并行）。
   *
   * @param backend 执行后端
   * @returns 必须串行时为 true
   */
  private static codeBackendRequiresSerial(backend: ExecutionBackend): boolean {
    return TerminalBenchRunner.callOptional(backend, 'requiresSerialExecution') === true;
  }

  /**
   * 调用后端的可选能力方法（不存在或抛错一律当作「未实现」）。
   *
   * @param backend 执行后端
   * @param method 方法名
   * @returns 返回值；不可用时为 undefined
   */
  private static callOptional<T>(backend: ExecutionBackend, method: string): T | undefined {
    const fn = (backend as unknown as Record<string, unknown>)[method];
    if (typeof fn !== 'function') {
      return undefined;
    }
    try {
      return (fn as (this: ExecutionBackend) => T).call(backend);
    } catch {
      return undefined;
    }
  }

  /**
   * 把未知异常收敛成一句可读原因。
   *
   * @param error 异常
   * @returns 原因文本
   */
  private static message(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  /**
   * 列出含 task.yaml 的任务子目录。
   *
   * @param root tasks 根目录
   * @returns 任务目录绝对路径列表（字典序）
   */
  private static listTasks(root: string): readonly string[] {
    if (!existsSync(root)) {
      throw new Error(`Terminal-Bench tasks 根目录不存在: ${root}`);
    }
    const dirs: string[] = [];
    for (const entry of readdirSync(root)) {
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
    return dirs.sort();
  }
}
