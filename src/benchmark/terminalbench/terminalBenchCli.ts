/**
 * B2 Terminal-Bench 评测 CLI 入口。
 *
 * 用法（构建后）：`node dist/src/benchmark/terminalbench/terminalBenchCli.js --tasks <dir> [--backend local|docker] [--baseline grep|omni] [--budget N] [--report <path>]`
 *
 * - `--backend docker` 本批未实现（沙箱无 docker），会 fail-closed 提示。
 * - `--baseline omni` 需注入真实 Agent 运行时；CLI 默认 fail-closed，提示改用自定义脚本。
 */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentRunner, BenchmarkBudget, ContainerBackend, Solver } from './types.js';
import { TerminalBenchRunner } from './terminalBenchRunner.js';
import { LocalContainerBackend } from './localContainerBackend.js';
import { GrepBaselineSolver } from './grepBaselineSolver.js';
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
  /** tasks 根目录。 */
  readonly tasksRoot: string;
  /** 后端种类。 */
  readonly backend: 'local' | 'docker';
  /** 基线种类。 */
  readonly baseline: 'grep' | 'omni';
  /** 最大工具调用次数。 */
  readonly budget: number;
  /** 报告路径。 */
  readonly reportPath: string;
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
    const backend = TerminalBenchCli.createBackend(opts.backend);
    const solver = TerminalBenchCli.createSolver(opts.baseline);
    const budget: BenchmarkBudget = { maxToolCalls: opts.budget, maxDurationMs: 600000 };
    const report = await TerminalBenchRunner.run({
      tasksRoot: opts.tasksRoot,
      backend,
      solver,
      budget,
      reportPath: opts.reportPath,
    });
    const pct = (report.passRate * 100).toFixed(1);
    process.stdout.write(
      `Terminal-Bench (${report.solver}): ${report.passed}/${report.total} = ${pct}%\n`,
    );
    process.stdout.write(`报告已写出: ${opts.reportPath}\n`);
  }

  /**
   * 创建容器后端；docker 本批未实现，fail-closed。
   *
   * @param kind 后端种类
   * @returns 后端实例（仅 local 可用）
   */
  private static createBackend(kind: 'local' | 'docker'): ContainerBackend {
    if (kind === 'docker') {
      throw new Error('docker 后端本批未实现（沙箱无 docker）；请用 --backend local 做适配器开发');
    }
    return LocalContainerBackend.create();
  }

  /**
   * 创建 Solver；omni 默认 fail-closed（需注入真实 Agent 运行时）。
   *
   * @param kind 基线种类
   * @returns Solver 实例
   */
  private static createSolver(kind: 'grep' | 'omni'): Solver {
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
    let tasksRoot = '';
    let backend: 'local' | 'docker' = 'local';
    let baseline: 'grep' | 'omni' = 'grep';
    let budget = 8;
    let reportPath = 'terminalbench.report.json';
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
        tasksRoot = next();
      } else if (arg === '--backend') {
        const v = next();
        backend = v === 'docker' ? 'docker' : 'local';
      } else if (arg === '--baseline') {
        const v = next();
        baseline = v === 'omni' ? 'omni' : 'grep';
      } else if (arg === '--budget') {
        budget = Number.parseInt(next(), 10);
      } else if (arg === '--report') {
        reportPath = next();
      } else if (arg === '--help' || arg === '-h') {
        process.stdout.write(TerminalBenchCli.usage());
        throw new HelpError();
      }
    }
    if (tasksRoot.length === 0) {
      throw new Error('缺少必填参数 --tasks <dir>');
    }
    return { tasksRoot, backend, baseline, budget, reportPath };
  }

  /**
   * 用法说明文本。
   *
   * @returns 用法字符串
   */
  private static usage(): string {
    return (
      [
        '用法: terminalBenchCli.js --tasks <dir> [--backend local|docker] [--baseline grep|omni] [--budget N] [--report <path>]',
        '  --tasks    Terminal-Bench tasks 根目录（必填）',
        '  --backend  local（默认，非隔离 dev 用）| docker（本批未实现）',
        '  --baseline grep（默认，同预算检索基线）| omni（需注入真实 Agent 运行时）',
        '  --budget   最大工具调用次数（默认 8）',
        '  --report   报告写出路径（默认 terminalbench.report.json）',
      ].join('\n') + '\n'
    );
  }
}

const isEntry =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntry) {
  void TerminalBenchCli.run(process.argv.slice(2));
}
