/**
 * 参考解 Solver：跑任务自带的 `solution.sh` / `solution.yaml`。
 *
 * ## 它存在的理由：把「保真度」变成可测量的数
 *
 * 一个基准适配器最危险的状态是「能跑但判不对」——它会稳定地输出漂亮的错误结论。
 * 参考解是唯一能证伪这种状态的东西：**参考解必须判通过**。
 * 于是 `--baseline gold` 的通过率就不是「能力分」，而是**该环境的保真度**：
 * 跑不过的题，说明本机缺了那题需要的用户态（apt 包、Linux 内核特性、systemd……），
 * 这些题目会在报告里以具体原因暴露出来，而不是被悄悄算成「模型不行」。
 *
 * ## 两种参考解形态
 *
 * - `solution.sh`：整段 POSIX shell，经 bash 在应用目录里执行（`/app` 由 bash 命名空间映射兜住）。
 * - `solution.yaml`：上游把交互式终端操作记成一串
 *   `- command: … / min_timeout_sec: … / block: … / append_enter: …`，
 *   本类只取 `command` 逐条经 `bash -lc` 执行（`min_timeout_sec` 是给交互式终端的下限，
 *   批量执行时没有意义；`append_enter` 同理）。
 *
 * 参考解**不做超时之外的任何裁剪**——它是 gold，不是被评测对象。
 */
import { readFileSync } from 'node:fs';
import type { CommandRunner, Solver, SolverInput, SolverOutcome } from './types.js';
import { BashLocator } from './bashLocator.js';

/** 参考解 Solver 选项。 */
export interface GoldSolutionSolverOptions {
  /** 执行命令的接缝（**必须**与后端同一个，否则源任务目录可能被就地改写）。 */
  readonly runner: CommandRunner;
  /** 单题超时（毫秒，缺省取任务的 `max_agent_timeout_sec`）。 */
  readonly timeoutMs?: number | undefined;
}

/** 参考解 Solver。 */
export class GoldSolutionSolver implements Solver {
  /** Solver 名（写入报告，用它与能力基线区分开）。 */
  public readonly name = 'gold-solution';

  /** 执行接缝。 */
  private readonly runner: CommandRunner;

  /** 覆盖超时（毫秒，0 表示用任务自述值）。 */
  private readonly timeoutMs: number;

  /** 已定位的 bash（未找到为 null）。 */
  private readonly bash: string | null;

  /**
   * @param options 选项（执行接缝 / 超时）。
   */
  public constructor(options: GoldSolutionSolverOptions) {
    this.runner = options.runner;
    this.timeoutMs = options.timeoutMs ?? 0;
    this.bash = BashLocator.locate();
  }

  /**
   * 执行参考解。
   *
   * @param input 求解上下文。
   * @returns 参考解产出（缺参考解/缺 bash 时也返回，不抛错——由判分器给出真实结论）。
   */
  public async solve(input: SolverInput): Promise<SolverOutcome> {
    const script = input.task.solutionScript;
    if (script === null) {
      return { answer: '该任务没有参考解文件，未执行任何操作', budgetUsed: 0 };
    }
    const timeoutMs =
      this.timeoutMs > 0 ? this.timeoutMs : Math.round(input.task.maxAgentTimeoutSec * 1000);
    const isShell = script.toLowerCase().endsWith('.sh');
    if (this.bash === null) {
      return { answer: '本机未找到 bash，无法执行参考解', budgetUsed: 0 };
    }
    if (isShell) {
      const outcome = await this.runner([this.bash, script], input.prepared.appDir, {}, timeoutMs);
      return { answer: GoldSolutionSolver.summarize(outcome), budgetUsed: 1 };
    }
    const commands = GoldSolutionSolver.commandsOf(script);
    let answer = '';
    let budgetUsed = 0;
    for (const command of commands) {
      budgetUsed += 1;
      const outcome = await this.runner(
        [this.bash, '-lc', command],
        input.prepared.appDir,
        {},
        timeoutMs,
      );
      answer += `${GoldSolutionSolver.summarize(outcome)}\n`;
    }
    return { answer, budgetUsed };
  }

  /**
   * 从 `solution.yaml` 里抽出命令序列。
   *
   * @param path 文件路径。
   * @returns 命令列表（读不到文件时为空）。
   */
  public static commandsOf(path: string): readonly string[] {
    let text = '';
    try {
      text = readFileSync(path, 'utf8');
    } catch {
      return [];
    }
    const commands: string[] = [];
    for (const line of text.split(/\r?\n/)) {
      const m = /^\s*-\s*command:\s*(.*)$/.exec(line);
      if (m !== null && m[1]!.trim() !== '') {
        commands.push(GoldSolutionSolver.unquote(m[1]!.trim()));
      }
    }
    return commands;
  }

  /**
   * 去掉 YAML 里包裹字符串的成对引号。
   *
   * @param value 原始取值。
   * @returns 去引号后的文本。
   */
  private static unquote(value: string): string {
    if (value.length >= 2) {
      const first = value[0]!;
      const last = value[value.length - 1]!;
      if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
        return value.slice(1, -1);
      }
    }
    return value;
  }

  /**
   * 把命令结果压成一行摘要（失败时带退出码）。
   *
   * @param outcome 命令结果。
   * @returns 摘要文本。
   */
  private static summarize(outcome: {
    readonly exitCode: number;
    readonly stdout: string;
    readonly stderr: string;
    readonly timedOut: boolean;
  }): string {
    if (outcome.exitCode === 0 && !outcome.timedOut) {
      return `ok: ${outcome.stdout.trim().slice(-200)}`;
    }
    const detail = (outcome.stderr || outcome.stdout).trim().slice(-300);
    return `exit ${outcome.exitCode}${outcome.timedOut ? '（超时）' : ''}: ${detail}`;
  }
}
