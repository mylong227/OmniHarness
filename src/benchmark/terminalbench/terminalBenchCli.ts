/**
 * B2 Terminal-Bench 评测 CLI 入口。
 *
 * 用法（构建后）：
 * `node dist/src/benchmark/terminalbench/terminalBenchCli.js --tasks <dir> [选项]`
 *
 * 常用形态：
 * - 先抓语料再跑：`--tasks eval-data/tbench/tasks --fetch --limit 15`
 * - 只跑指定题：`--tasks <dir> --only hello-world,csv-to-parquet`
 * - 只看环境能不能跑：`--check`（不执行任何任务，只打印能力与原因）
 *
 * 执行后端固定为**原生**（`NativeExecutionBackend`）：每任务一次性目录 + 现场重建解释器环境，
 * 不依赖任何容器运行时。`--baseline omni` 需注入真实 Agent 运行时；CLI 默认 fail-closed。
 */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentRunner, BenchmarkBudget, Solver } from './types.js';
import { TerminalBenchRunner } from './terminalBenchRunner.js';
import { NativeExecutionBackend } from './nativeExecutionBackend.js';
import { PytestJudge } from './pytestJudge.js';
import { TaskFetcher } from './taskFetcher.js';
import { GrepBaselineSolver } from './grepBaselineSolver.js';
import { GoldSolutionSolver } from './goldSolutionSolver.js';
import { OmniSolver } from './omniSolver.js';

/** `--help` 请求的专用错误，用于在主流程里干净退出（exit 0）。 */
class HelpError extends Error {
  public constructor() {
    super('help');
    this.name = 'HelpError';
  }
}

/** CLI 解析出的选项。 */
interface CliOptions {
  /** tasks 根目录（也是 `--fetch` 的落盘目录）。 */
  readonly tasksRoot: string;
  /** 基线种类。 */
  readonly baseline: 'grep' | 'omni' | 'gold';
  /** 最大工具调用次数。 */
  readonly budget: number;
  /** 报告路径。 */
  readonly reportPath: string;
  /** 一次性工作目录的父目录（空串表示用后端默认）。 */
  readonly workRoot: string;
  /** 并发上限。 */
  readonly concurrency: number;
  /** 只跑这些任务名。 */
  readonly onlyTasks: readonly string[];
  /** 语料抓取上限（0 表示不限）。 */
  readonly limit: number;
  /** 是否先抓语料。 */
  readonly fetch: boolean;
  /** GitHub 令牌（抓语料用）。 */
  readonly token: string;
  /** 是否关闭 `/app` 映射。 */
  readonly noAppMap: boolean;
  /** 只做环境自检。 */
  readonly check: boolean;
}

/** Terminal-Bench 评测 CLI。 */
export class TerminalBenchCli {
  private constructor() {}

  /**
   * 进程入口。
   *
   * @param argv 命令行参数（不含 node 与脚本名）
   * @returns 无（仅写入标准输出并设退出码）
   */
  public static async run(argv: readonly string[]): Promise<void> {
    let opts: CliOptions;
    try {
      opts = TerminalBenchCli.parseArgs(argv);
    } catch (err) {
      if (err instanceof HelpError) {
        process.exitCode = 0;
        return;
      }
      throw err;
    }
    const backend = TerminalBenchCli.createBackend(opts);
    const reason = backend.unavailableReason();
    if (opts.check) {
      process.stdout.write(
        reason === null
          ? `环境自检：可用（后端 ${backend.name}，工作目录盘符 ${backend.appRootDrive() || '(无)'}）\n`
          : `环境自检：不可用 —— ${reason}\n`,
      );
      process.exitCode = reason === null ? 0 : 1;
      return;
    }
    if (reason !== null) {
      // 机器级不可用：整轮跑下去只会得到满屏「环境失败」，先说清楚再决定。
      process.stdout.write(`⚠️ 执行环境不可用：${reason}\n`);
    }
    if (opts.fetch) {
      await TerminalBenchCli.fetchCorpus(opts);
    }
    const report = await TerminalBenchRunner.run({
      tasksRoot: resolve(opts.tasksRoot),
      backend,
      solver: TerminalBenchCli.createSolver(opts.baseline, backend),
      judge: new PytestJudge(backend),
      budget: { maxToolCalls: opts.budget, maxDurationMs: 600000 } satisfies BenchmarkBudget,
      reportPath: resolve(opts.reportPath),
      concurrency: opts.concurrency,
      onlyTasks: opts.onlyTasks,
    });
    process.stdout.write(TerminalBenchCli.summarize(report, opts.reportPath));
  }

  /**
   * 抓取上游语料。
   *
   * @param opts 选项
   * @returns 无
   */
  private static async fetchCorpus(opts: CliOptions): Promise<void> {
    const fetcher = new TaskFetcher(opts.token === '' ? {} : { token: opts.token });
    const outcome = await fetcher.fetch(
      resolve(opts.tasksRoot),
      opts.onlyTasks,
      opts.limit === 0 ? undefined : opts.limit,
    );
    process.stdout.write(
      `语料抓取：成功 ${outcome.fetched.length} 题` +
        (outcome.failures.length === 0
          ? '\n'
          : `，失败 ${outcome.failures.length} 项（前 3 条：${outcome.failures.slice(0, 3).join(' / ')}）\n`),
    );
  }

  /**
   * 把报告渲染成一行摘要 + 环境失败分布。
   *
   * @param report 汇总报告
   * @param reportPath 报告路径
   * @returns 摘要文本
   */
  private static summarize(
    report: Awaited<ReturnType<typeof TerminalBenchRunner.run>>,
    reportPath: string,
  ): string {
    const pct = (report.passRate * 100).toFixed(1);
    const effective = (report.effectivePassRate * 100).toFixed(1);
    const lines = [
      `Terminal-Bench (${report.solver}@${report.backend}, judge=${report.judge}, ${report.platform}): ` +
        `${report.passed}/${report.total} = ${pct}% | 环境失败 ${report.envErrors} | ` +
        `有效解题率 ${report.passed}/${report.total - report.envErrors} = ${effective}%`,
    ];
    const reasons = Object.entries(report.envErrorReasons);
    if (reasons.length > 0) {
      lines.push('环境失败原因：');
      for (const [reason, count] of reasons) {
        lines.push(`  ${count} × ${reason}`);
      }
    }
    lines.push(`报告已写出: ${reportPath}`);
    return lines.join('\n') + '\n';
  }

  /**
   * 创建执行后端（固定原生后端）。
   *
   * @param opts 选项
   * @returns 后端实例
   */
  private static createBackend(opts: CliOptions): NativeExecutionBackend {
    return new NativeExecutionBackend({
      ...(opts.workRoot.trim() === '' ? {} : { workRoot: resolve(opts.workRoot) }),
      appMap: !opts.noAppMap,
    });
  }

  /**
   * 创建 Solver。
   *
   * - `gold`：跑任务自带参考解，用来量**环境保真度**（参考解必过，跑不过就是缺用户态）。
   * - `grep`：同预算纯检索基线，用来量**任务本身的天花板**（不解题，几乎必挂）。
   * - `omni`：真实 Agent 驱动，需注入运行时；CLI 默认 fail-closed。
   *
   * @param kind 基线种类
   * @param backend 执行后端（gold 需要一个与后端同源的执行接缝）
   * @returns Solver 实例
   */
  private static createSolver(
    kind: 'grep' | 'omni' | 'gold',
    backend: NativeExecutionBackend,
  ): Solver {
    if (kind === 'gold') {
      return new GoldSolutionSolver({
        runner: (cmd, workdir, extraEnv, timeoutMs) =>
          backend.runCommand(cmd, workdir, extraEnv, timeoutMs),
      });
    }
    if (kind === 'grep') {
      return GrepBaselineSolver.create();
    }
    return OmniSolver.create(TerminalBenchCli.failClosedRunner);
  }

  /**
   * 未注入真实 Agent 运行时时的 fail-closed 接缝。
   *
   * @returns 永不 resolve（抛错）
   */
  private static readonly failClosedRunner: AgentRunner = () => {
    throw new Error(
      'OmniSolver 未注入真实 Agent 运行时。请编写自定义脚本：import { OmniSolver } from ".../omniSolver.js"; OmniSolver.create(realRunner)，再调用 TerminalBenchRunner.run(...)',
    );
  };

  /**
   * 解析命令行参数（fail-closed：缺 --tasks 即报错）。
   *
   * @param argv 参数列表
   * @returns 解析后的选项
   */
  private static parseArgs(argv: readonly string[]): CliOptions {
    const opts = {
      tasksRoot: '',
      baseline: 'grep' as 'grep' | 'omni' | 'gold',
      budget: 8,
      reportPath: 'terminalbench.report.json',
      workRoot: '',
      concurrency: 1,
      onlyTasks: [] as readonly string[],
      limit: 0,
      fetch: false,
      token: '',
      noAppMap: false,
      check: false,
    };
    for (let i = 0; i < argv.length; i += 1) {
      const arg = argv[i]!;
      const next = (): string => {
        const v = argv[i + 1];
        if (v === undefined) {
          throw new Error(`参数 ${arg} 缺少取值`);
        }
        i += 1;
        return v;
      };
      if (arg === '--tasks') {
        opts.tasksRoot = next();
      } else if (arg === '--baseline') {
        const value = next();
        opts.baseline = value === 'omni' ? 'omni' : value === 'gold' ? 'gold' : 'grep';
      } else if (arg === '--budget') {
        opts.budget = Number.parseInt(next(), 10);
      } else if (arg === '--report' || arg === '--out') {
        opts.reportPath = next();
      } else if (arg === '--work-root') {
        opts.workRoot = next();
      } else if (arg === '--concurrency') {
        opts.concurrency = Math.max(1, Number.parseInt(next(), 10) || 1);
      } else if (arg === '--only') {
        opts.onlyTasks = next()
          .split(',')
          .map((s) => s.trim())
          .filter((s) => s !== '');
      } else if (arg === '--limit') {
        opts.limit = Math.max(0, Number.parseInt(next(), 10) || 0);
      } else if (arg === '--fetch') {
        opts.fetch = true;
      } else if (arg === '--github-token') {
        opts.token = next();
      } else if (arg === '--no-app-map') {
        opts.noAppMap = true;
      } else if (arg === '--check') {
        opts.check = true;
      } else if (arg === '--help' || arg === '-h') {
        process.stdout.write(TerminalBenchCli.usage());
        throw new HelpError();
      }
    }
    if (opts.tasksRoot.length === 0) {
      throw new Error('缺少必填参数 --tasks <dir>');
    }
    return opts;
  }

  /**
   * 用法说明文本。
   *
   * @returns 用法字符串
   */
  private static usage(): string {
    return (
      [
        '用法: terminalBenchCli.js --tasks <dir> [选项]',
        '  --tasks <dir>      任务语料根目录（必填）；与 --fetch 同用时为落盘目录',
        '  --fetch            先从上游拉取语料（GITHUB_TOKEN / --github-token 提高配额）',
        '  --limit N           抓取/运行的任务数上限（0=不限）',
        '  --only a,b          只跑指定任务名',
        '  --baseline grep|gold|omni',
        '                      grep（默认，同预算检索基线）| gold（跑参考解，量环境保真度）',
        '                      omni（需注入真实 Agent 运行时）',
        '  --budget N          最大工具调用次数（默认 8；gold 基线不消耗预算）',
        '  --report|--out <p>  报告写出路径（默认 terminalbench.report.json）',
        '  --work-root <dir>   一次性工作目录父目录（默认 <cwd>/.omniharness/tbench-work）',
        '  --concurrency N     并发数（映射 /app 时后端会强制压到 1）',
        '  --no-app-map        关闭容器内 /app 映射（诊断用；依赖 /app 的任务会失败）',
        '  --check             只做环境自检并退出（0=可跑，1=不可跑）',
        '执行后端固定为原生后端：每任务一次性目录 + uv 现场重建环境，不依赖任何容器运行时。',
      ].join('\n') + '\n'
    );
  }
}

const isEntry =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntry) {
  void TerminalBenchCli.run(process.argv.slice(2));
}
