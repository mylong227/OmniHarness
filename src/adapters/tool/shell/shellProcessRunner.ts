/**
 * shell 子进程执行器（A3 工具层纵深第三环）。
 *
 * 从 `promisify(exec)` 换成**显式 `spawn`**，收益是三件原先拿不到的事：
 * 1. **真实退出码 / 信号**：`exec` 在非零退出时直接 reject，退出码只能从错误文案里猜；
 *    这里显式回传 `exitCode` / `signal`，让上层能把「命令跑完但失败」与「进程异常」分开。
 * 2. **可控输出上限**：超限即截断并标记（`overflowed`），不再靠 `exec` 抛 `maxBuffer exceeded`。
 * 3. **超时可判定**：`timedOut` 是显式字段，不再与「命令自己以非零码退出」混淆。
 *
 * 执行形态（shell 解释器 + `-c` 命令文本）保持不变——`shell` 工具的对外契约包含管道与重定向。
 * shell 可执行文件位置**由环境派生**（`ComSpec` / `SHELL`），不硬编码绝对路径。
 */

import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { ShellInvocation } from './shellInvocation.js';

/** 单次执行参数。 */
export interface ShellRunOptions {
  /** 工作目录（`undefined` 表示继承进程 cwd）。 */
  readonly cwd: string | undefined;
  /** 子进程环境变量。 */
  readonly env: NodeJS.ProcessEnv;
  /** 超时（毫秒），到时终止子进程并置 `timedOut`。 */
  readonly timeoutMs: number;
  /** 单路（stdout / stderr 各自）缓冲上限（字节），超出即截断并置 `overflowed`。 */
  readonly maxBufferBytes: number;
}

/** 单次执行结果（不抛异常，全部状态显式回传）。 */
export interface ShellRunOutcome {
  /** 标准输出的原始字节（未解码，交由调用方按码页解码）。 */
  readonly stdout: Buffer;
  /** 标准错误的原始字节。 */
  readonly stderr: Buffer;
  /** 退出码（被信号终止时为 `null`）。 */
  readonly exitCode: number | null;
  /** 终止信号（未因信号终止时为 `null`）。 */
  readonly signal: string | null;
  /** 是否因超时被终止。 */
  readonly timedOut: boolean;
  /** 输出是否超限被截断（截断同时会终止子进程）。 */
  readonly overflowed: boolean;
}

/** 输出累积器。 */
interface Collector {
  chunks: Buffer[];
  bytes: number;
}

/**
 * shell 子进程执行器：`spawn` 显式 argv 执行命令文本，状态全过程显式。
 */
export class ShellProcessRunner {
  /**
   * 执行命令。
   *
   * @param command 命令文本（调用方已完成校验与策略裁决）。
   * @param options 执行参数（cwd / env / 超时 / 缓冲上限）。
   * @returns 执行结果；`spawn` 自身失败（如 shell 不存在）时 reject。
   */
  public run(command: string, options: ShellRunOptions): Promise<ShellRunOutcome> {
    return new Promise<ShellRunOutcome>((resolve, reject) => {
      const shell = ShellInvocation.path();
      let child: ChildProcess;
      try {
        child = spawn(shell, ShellInvocation.args(shell, command), {
          cwd: options.cwd,
          env: options.env,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
        return;
      }

      const out: Collector = { chunks: [], bytes: 0 };
      const err: Collector = { chunks: [], bytes: 0 };
      let timedOut = false;
      let overflowed = false;
      let settled = false;

      const finish = (exitCode: number | null, signal: string | null): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve({
          stdout: Buffer.concat(out.chunks),
          stderr: Buffer.concat(err.chunks),
          exitCode,
          signal,
          timedOut,
          overflowed,
        });
      };

      const terminate = (): void => {
        if (!settled) {
          child.kill('SIGKILL');
        }
      };

      const timer = setTimeout(() => {
        timedOut = true;
        terminate();
      }, options.timeoutMs);

      this.pipe(child.stdout, out, options.maxBufferBytes, () => {
        overflowed = true;
        terminate();
      });
      this.pipe(child.stderr, err, options.maxBufferBytes, () => {
        overflowed = true;
        terminate();
      });

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

  /**
   * 收集一路输出，超限即回调（由调用方决定终止策略）。
   *
   * @param stream 子进程输出流（可能为 null，取决于 stdio 配置）。
   * @param collector 该路累积器。
   * @param cap 上限（字节）。
   * @param onOverflow 超限回调。
   * @returns 无返回值。
   */
  private pipe(
    stream: NodeJS.ReadableStream | null,
    collector: Collector,
    cap: number,
    onOverflow: () => void,
  ): void {
    if (stream === null) {
      return;
    }
    stream.on('data', (chunk: Buffer | string) => {
      const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      if (collector.bytes + buf.length > cap) {
        onOverflow();
        return;
      }
      collector.chunks.push(buf);
      collector.bytes += buf.length;
    });
  }
}
