/**
 * 受控测试命令执行器端口（P3 自验证回环）。
 *
 * 自验证回环需要在**受控超时 + 输出上限**下跑一条测试命令，并把「退出码 / 输出 / 是否超时」
 * 显式回传（不抛异常）。本文件只定义窄接口，便于：
 *  ① 生产用 `ShellTestCommandRunner`（复用 `ShellProcessRunner`，零新增依赖）；
 *  ② 单测用测试替身（不真跑进程）。
 */

/** 单次受控命令执行结果（不抛异常，全部状态显式回传）。 */
export interface TestRunOutcome {
  /** 退出码（被信号终止时为 `null`）。 */
  readonly exitCode: number | null;
  /** 合并后的输出文本（stdout + stderr，可能已被上限截断）。 */
  readonly output: string;
  /** 是否因超时被终止。 */
  readonly timedOut: boolean;
}

/** 受控测试命令执行器端口。 */
export interface TestCommandRunner {
  /**
   * 在受控预算内执行一条命令。
   *
   * @param command 命令文本（由调用方提供，通常来自仓库 `package.json` 的 `scripts.test`）。
   * @param cwd 工作目录（仓库根）。
   * @param timeoutMs 超时（毫秒），到时终止子进程。
   * @param maxOutputBytes 单路输出缓冲上限（字节），超出即截断。
   * @returns 单次执行结果（不抛异常；仅当无法启动子进程时才 reject）。
   */
  run(
    command: string,
    cwd: string,
    timeoutMs: number,
    maxOutputBytes: number,
  ): Promise<TestRunOutcome>;
}
