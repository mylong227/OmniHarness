/**
 * 基于 `ShellProcessRunner` 的受控测试命令执行器（P3 自验证回环）。
 *
 * 复用既有 shell 执行能力（零新增依赖、零新进程语义）：把 `ShellRunOutcome` 的
 * `Buffer` 输出解码为文本，并只保留回环需要的三要素（退出码 / 输出 / 超时）。
 */
import { ShellProcessRunner } from '../shell/shellProcessRunner.js';
import type { TestCommandRunner, TestRunOutcome } from './testCommandRunner.js';

/** 合并 stdout 与 stderr 的文本视图（截断标记由 runner 的 overflowed 语义承担）。 */
export class ShellTestCommandRunner implements TestCommandRunner {
  /** 底层 shell 执行器（无状态，可复用）。 */
  private readonly runner: ShellProcessRunner;

  /**
   * @param runner 可注入的 shell 执行器（缺省新建；测试可注入替身）。
   */
  public constructor(runner: ShellProcessRunner = new ShellProcessRunner()) {
    this.runner = runner;
  }

  /**
   * 在受控预算内执行一条命令（stdout + stderr 合并为单一文本）。
   *
   * @param command 命令文本（调用方已完成来源校验）。
   * @param cwd 工作目录（仓库根）。
   * @param timeoutMs 超时（毫秒）。
   * @param maxOutputBytes 单路输出缓冲上限（字节）。
   * @returns 单次执行结果（退出码 / 合并文本 / 是否超时）。
   */
  public async run(
    command: string,
    cwd: string,
    timeoutMs: number,
    maxOutputBytes: number,
  ): Promise<TestRunOutcome> {
    const outcome = await this.runner.run(command, {
      cwd,
      env: process.env,
      timeoutMs,
      maxBufferBytes: maxOutputBytes,
    });
    const output = `${outcome.stdout.toString('utf8')}${outcome.stderr.toString('utf8')}`;
    return { exitCode: outcome.exitCode, output, timedOut: outcome.timedOut };
  }
}
