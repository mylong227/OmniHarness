/**
 * 交互式前台执行器：以 `stdio: 'inherit'` 把**父进程的真终端**原样交给子进程。
 *
 * ## 为什么是 `inherit` 而不是管道
 *
 * 交互式 TUI 需要的不只是「能写」：它要读按键、查窗口尺寸、收 SIGWINCH、切换备用屏缓冲。
 * 这些都是**终端设备**的属性，只有继承同一个真终端才成立。用管道捕获输出会把这些全部丢掉——
 * 于是 vim 起不来、交互式安装器直接报「not a terminal」。故本执行器**不捕获任何输出**：
 * 输出直接写在用户的终端上，工具只回传**退出码/信号/超时**这三件可判定的事实。
 *
 * 与 {@link ShellProcessRunner} 的分工：那个走管道、要缓冲与截断（非交互命令）；
 * 本执行器走直通、零缓冲（交互式会话）。两者不共享实现是有意为之——
 * 「同一份代码既捕获输出又直通终端」在 stdio 配置上必须二选一，混在一起只会两边都错。
 */
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';

/** 单次交互式执行参数。 */
export interface InteractiveRunOptions {
  /** 工作目录（`undefined` 表示继承进程 cwd）。 */
  readonly cwd: string | undefined;
  /** 子进程环境变量。 */
  readonly env: NodeJS.ProcessEnv;
  /** 超时（毫秒），到时终止子进程并置 `timedOut`。 */
  readonly timeoutMs: number;
}

/** 单次交互式执行结果（不抛异常，状态显式回传）。 */
export interface InteractiveRunOutcome {
  /** 退出码（被信号终止时为 `null`）。 */
  readonly exitCode: number | null;
  /** 终止信号（未因信号终止时为 `null`）。 */
  readonly signal: string | null;
  /** 是否因超时被终止。 */
  readonly timedOut: boolean;
}

/**
 * 交互式前台执行器：`spawn` + `stdio: 'inherit'`，只回传退出状态。
 */
export class ShellInteractiveExecutor {
  /**
   * 以前台直通方式执行命令。
   *
   * @param bin 可执行文件（由 {@link PtyCapability.argvOf} 构造）。
   * @param args argv 数组。
   * @param options 执行参数（cwd / env / 超时）。
   * @returns 执行结果；`spawn` 自身失败（可执行文件不存在等）时 reject。
   */
  public run(
    bin: string,
    args: readonly string[],
    options: InteractiveRunOptions,
  ): Promise<InteractiveRunOutcome> {
    return new Promise<InteractiveRunOutcome>((resolve, reject) => {
      let child: ChildProcess;
      try {
        child = spawn(bin, [...args], {
          cwd: options.cwd,
          env: options.env,
          stdio: 'inherit',
        });
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      let timedOut = false;
      let settled = false;
      const finish = (exitCode: number | null, signal: string | null): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve({ exitCode, signal, timedOut });
      };
      const timer = setTimeout(() => {
        timedOut = true;
        if (!settled) {
          try {
            child.kill('SIGKILL');
          } catch {
            // 进程可能已退出；超时仍如实回传（不因 kill 失败而谎报成功）。
          }
        }
      }, options.timeoutMs);
      child.on('error', (error: Error) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        reject(error);
      });
      child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
        finish(code, signal);
      });
    });
  }
}
