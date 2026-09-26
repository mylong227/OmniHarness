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
import { ShellInvocation } from './shellInvocation.js';
import { ProcessTreeKiller } from './processTreeKiller.js';

/** 单次交互式执行参数。 */
export interface InteractiveRunOptions {
  /** 工作目录（`undefined` 表示继承进程 cwd）。 */
  readonly cwd: string | undefined;
  /** 子进程环境变量。 */
  readonly env: NodeJS.ProcessEnv;
  /** 超时（毫秒），到时终止子进程并置 `timedOut`。 */
  readonly timeoutMs: number;
  /** 会话取消信号（可选）：中止即终止整棵进程树（与前台 shell 同一口径）。 */
  readonly signal?: AbortSignal | undefined;
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
          // cmd 形态的命令串自带引号（见 ShellInvocation.args），须原样传递（审计 §1.9）。
          windowsVerbatimArguments: ShellInvocation.needsVerbatimArgs(bin),
        });
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      let timedOut = false;
      let settled = false;
      /** 会话取消时的收尾（与超时同一路径：终止整棵进程树，如实回传 signal）。 */
      const onAbort = (): void => {
        if (settled) {
          return;
        }
        ProcessTreeKiller.kill(child);
      };
      const finish = (exitCode: number | null, signal: string | null): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', onAbort);
        resolve({ exitCode, signal, timedOut });
      };
      const timer = setTimeout(() => {
        timedOut = true;
        if (!settled) {
          // 树杀而非 `child.kill`（2026-09-26 审计 S12）：交互式会话的载荷是孙进程，
          // 只杀直接子进程会让「已超时」的命令继续跑（最长到 1 小时上限）。
          ProcessTreeKiller.kill(child);
        }
      }, options.timeoutMs);
      // 转发会话取消（前台 shell 早已这么做，交互式这条支路漏了）：不转发时撤销回合也停不下来。
      if (options.signal !== undefined) {
        if (options.signal.aborted) {
          onAbort();
        } else {
          options.signal.addEventListener('abort', onAbort, { once: true });
        }
      }
      child.on('error', (error: Error) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', onAbort);
        reject(error);
      });
      child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
        finish(code, signal);
      });
    });
  }
}
