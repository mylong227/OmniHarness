/**
 * pytest 判分器：上游 `run-tests.sh` 的**语义等价**实现。
 *
 * 上游判分脚本的实质只有最后一行——`uv run pytest $TEST_DIR/test_outputs.py -rA`，
 * 前面几行（装 curl、装 uv、建 `.tbench-testing` venv、装包）都是为了在容器里**把这条命令跑起来**
 * 所做的自举。原生执行里解释器与依赖已由 {@link PythonEnvironmentProvisioner} 就位，
 * 于是本类只做那一行，并保持三件与上游一致的事：
 *
 * ① 工作目录 = 应用根（判分脚本里的相对路径与 `./x` 依赖它）；
 * ② 注入 `TEST_DIR` 环境变量指向判分脚本目录（脚本正文用到）；
 * ③ 退出码即通过与否（pytest 全绿为 0），`-rA` 保留失败汇总便于人审阅。
 *
 * 判分**超时**的分账口径（容易做错，故写死在这里）：
 * - 超时且**无任何输出** ⇒ 环境失败（判分进程根本没起来，例如解释器不可用）；
 * - 超时但已有输出 ⇒ 能力失败（判分确实在跑，是解法/用例本身慢）。
 * 把后者记成环境失败等于替模型开脱；把前者记成能力失败等于把机器问题算到模型头上。
 */
import type { JudgeOutcome, PreparedTask, TaskJudge, TerminalBenchTask } from './types.js';
import type { ExecutionBackend } from './types.js';

/** 判分输出进报告的上限（字符）。 */
const MAX_OUTPUT_CHARS = 4000;

/** pytest 判分器。 */
export class PytestJudge implements TaskJudge {
  /** 判分器名（写入报告）。 */
  public readonly name = 'pytest';

  /** 执行后端（判分命令经它执行，不直连宿主）。 */
  private readonly backend: ExecutionBackend;

  /**
   * @param backend 执行后端。
   */
  public constructor(backend: ExecutionBackend) {
    this.backend = backend;
  }

  /**
   * 执行判分。
   *
   * @param task 任务元信息。
   * @param prepared 后端准备好的上下文。
   * @returns 判分结果（环境原因走 `envError`，不抛错）。
   */
  public async judge(task: TerminalBenchTask, prepared: PreparedTask): Promise<JudgeOutcome> {
    if (task.parserName !== 'pytest') {
      return PytestJudge.envFailure(
        `不支持的判分器 parser_name=${task.parserName || '(空)'}（本适配器只实现了 pytest）`,
        '',
      );
    }
    if (prepared.pythonPath === null) {
      return PytestJudge.envFailure('判分环境未就绪（未装出 Python 解释器）', '');
    }
    const target = `${prepared.testsDir}${process.platform === 'win32' ? '\\' : '/'}test_outputs.py`;
    const timeoutMs = Math.max(1, Math.round(task.maxTestTimeoutSec * 1000));
    const outcome = await this.backend.runCommand(
      [prepared.pythonPath, '-m', 'pytest', target, '-rA'],
      prepared.appDir,
      { ...prepared.env, TEST_DIR: prepared.testsDir },
      timeoutMs,
    );
    const output = PytestJudge.summarize(outcome.stdout, outcome.stderr);
    if (outcome.timedOut && output.length === 0) {
      return PytestJudge.envFailure(`判分超时且无任何输出（上限 ${task.maxTestTimeoutSec}s）`, '');
    }
    return {
      passed: outcome.exitCode === 0 && !outcome.timedOut,
      exitCode: outcome.exitCode,
      output,
      timedOut: outcome.timedOut,
      envError: null,
    };
  }

  /**
   * 构造环境失败结果。
   *
   * @param reason 原因（会写进报告，须可执行）。
   * @param output 已有输出。
   * @returns 环境失败判分结果。
   */
  private static envFailure(reason: string, output: string): JudgeOutcome {
    return { passed: false, exitCode: -1, output, timedOut: false, envError: reason };
  }

  /**
   * 把 stdout/stderr 合成一份有界摘要。
   *
   * @param stdout 标准输出。
   * @param stderr 标准错误。
   * @returns 摘要文本（失败信息通常在两路输出的尾部，故保留尾部）。
   */
  private static summarize(stdout: string, stderr: string): string {
    const merged = [stdout.trim(), stderr.trim()].filter((s) => s !== '').join('\n');
    return merged.length <= MAX_OUTPUT_CHARS
      ? merged
      : merged.slice(merged.length - MAX_OUTPUT_CHARS);
  }
}
