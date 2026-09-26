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
import { ProcessTreeKiller } from './processTreeKiller.js';

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
  /**
   * 是否分配伪终端（PTY）执行：经 GNU `script` 包一层，让 TUI 程序拿到真终端。
   * `true` 时会调用 {@link ShellInvocation.ptyCommand} 得到 `{bin,args}`；
   * 当前平台不可用时该方法会**同步抛出**，由 {@link run} 的 try/catch 转成 reject（上层 fail-closed）。
   * 省略时按 `false` 处理（普通管道执行）。
   */
  readonly pty?: boolean;
  /**
   * 会话取消信号（审计 §1.7）：给出时，取消即**立即终止整棵进程树**并置 `aborted`。
   * 此前该信号根本没被本执行器消费——取消后命令仍会跑到自己的超时（最长 10 分钟），
   * 且只杀直接子进程。省略时行为与改造前逐字一致（零行为变更）。
   */
  readonly signal?: AbortSignal | undefined;
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
  /** 是否因会话取消信号被终止（与超时区分，便于上层给出不同文案）。 */
  readonly aborted: boolean;
}

/** 输出累积器。 */
interface Collector {
  chunks: Buffer[];
  bytes: number;
}

/** 一次执行的内部状态（`run` 与其终止装配共享，避免把 `run` 撑成超长函数）。 */
interface RunState {
  readonly out: Collector;
  readonly err: Collector;
  timedOut: boolean;
  overflowed: boolean;
  aborted: boolean;
  settled: boolean;
}

/** 终止装配的句柄：`clear()` 撤销定时器与取消订阅，`terminate()` 终止整棵树。 */
interface TerminationHandle {
  clear(): void;
  terminate(): void;
  /** 绑定「终止后宽限期到期仍未收到 close」的兜底收尾回调（见 `run` 内注释）。 */
  onGiveUp(callback: () => void): void;
}

/**
 * shell 子进程执行器：`spawn` 显式 argv 执行命令文本，状态全过程显式。
 */
export class ShellProcessRunner {
  /**
   * 终止后的宽限期（毫秒）：到期仍未收到 `close` 即按已终止收尾。
   *
   * 依据：树杀是**尽力而为**（taskkill 可能不可用、child.kill 可能抛错），而本模块把这三种
   * 终止路径都当成「进程已死 ⇒ close 必来」。宽限期把这个假设的失败面收敛为有界等待，
   * 代价只是少一次真实退出码（`exitCode=null`），换来的是回合不会永久挂住。
   */
  private static readonly TERMINATE_GRACE_MS = 3_000;

  /**
   * 执行命令。
   *
   * @param command 命令文本（调用方已完成校验与策略裁决）。
   * @param options 执行参数（cwd / env / 超时 / 缓冲上限 / 可选会话取消信号）。
   * @returns 执行结果；`spawn` 自身失败（如 shell 不存在）时 reject。
   */
  public run(command: string, options: ShellRunOptions): Promise<ShellRunOutcome> {
    return new Promise<ShellRunOutcome>((resolve, reject) => {
      let child: ChildProcess;
      try {
        const invocation = ShellProcessRunner.invocationOf(command, options);
        child = spawn(invocation.bin, invocation.args, {
          cwd: options.cwd,
          env: options.env,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
          // cmd 形态下命令串自带引号（见 ShellInvocation.args），必须原样传递，
          // 否则 Node 的常规转义会与 cmd 的解析叠加，把带引号参数粘成一个（审计 §1.9）。
          windowsVerbatimArguments: ShellInvocation.needsVerbatimArgs(invocation.bin),
          // POSIX 上让 shell 成为**自己的进程组组长**，终止时才能用 `kill(-pid)` 连带整棵树
          // （非 detached 的子进程继承父进程组，负 pid 会 ESRCH ⇒ 只能杀到 shell 本身）。
          // Windows 不用这种方式：那里的树终止交给 `taskkill /T`（见 ProcessTreeKiller）。
          detached: process.platform !== 'win32',
        });
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
        return;
      }

      const state: RunState = {
        out: { chunks: [], bytes: 0 },
        err: { chunks: [], bytes: 0 },
        timedOut: false,
        overflowed: false,
        aborted: false,
        settled: false,
      };
      const handle = this.armTermination(child, options, state);

      const finish = (exitCode: number | null, signal: string | null): void => {
        if (state.settled) {
          return;
        }
        state.settled = true;
        handle.clear();
        resolve({
          stdout: Buffer.concat(state.out.chunks),
          stderr: Buffer.concat(state.err.chunks),
          exitCode,
          signal,
          timedOut: state.timedOut,
          overflowed: state.overflowed,
          aborted: state.aborted,
        });
      };

      // 兜底：三条终止路径都把「进程已死」当作 `close` 事件的充分条件，但**树杀本身可能失败**
      // （taskkill 不可用 + child.kill 抛错），此时 `close` 永不触发、`run()` 永不 settle
      // （2026-09-26 审计 X5，本模块的变异测试曾在此挂死）。绑定「终止后宽限期」回调：到期仍未
      // 收到 close 就按已终止收尾——宁可少一次真实退出码，也不能让整个回合挂住。
      handle.onGiveUp(() => {
        finish(null, 'SIGKILL');
      });

      child.on('error', (error: Error) => {
        if (state.settled) {
          return;
        }
        state.settled = true;
        handle.clear();
        reject(error);
      });
      child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
        finish(code, signal);
      });
    });
  }

  /**
   * 装配三条终止路径（**超时 / 输出超限 / 会话取消**）与两路输出收集。
   *
   * 三条路径都调用同一个 `terminate()`：终止**整棵进程树**（见 {@link ProcessTreeKiller}），
   * 而不是只杀 shell 本身——否则孙进程会继续跑并**持有 stdout 管道**，让 `close` 事件永不触发。
   * @param child 已 spawn 的子进程。
   * @param options 执行参数（超时 / 缓冲上限 / 可选取消信号）。
   * @param state 本次执行的共享状态（终止原因写在其中）。
   * @returns 句柄：`clear()` 撤销定时器与取消订阅，`terminate()` 主动终止，
   *          `onGiveUp(cb)` 绑定「终止后宽限期到期仍未收到 close」的兜底收尾。
   */
  private armTermination(
    child: ChildProcess,
    options: ShellRunOptions,
    state: RunState,
  ): TerminationHandle {
    let giveUpTimer: ReturnType<typeof setTimeout> | undefined;
    let onGiveUp: (() => void) | undefined;
    const terminate = (): void => {
      if (state.settled) {
        return;
      }
      ProcessTreeKiller.kill(child);
      // 宽限期：树杀失败时 `close` 永不触发，到期强制收尾（见 `run` 内注释）。
      if (giveUpTimer === undefined) {
        giveUpTimer = setTimeout(() => {
          if (!state.settled) {
            onGiveUp?.();
          }
        }, ShellProcessRunner.TERMINATE_GRACE_MS);
      }
    };
    const onAbort = (): void => {
      state.aborted = true;
      terminate();
    };
    const timer = setTimeout(() => {
      state.timedOut = true;
      terminate();
    }, options.timeoutMs);

    if (options.signal !== undefined) {
      if (options.signal.aborted) {
        // 已取消：仍然 spawn 了（无法在此处提前返回而不改契约），立即终止，避免白留一棵树。
        onAbort();
      } else {
        options.signal.addEventListener('abort', onAbort, { once: true });
      }
    }

    this.pipe(child.stdout, state.out, options.maxBufferBytes, () => {
      state.overflowed = true;
      terminate();
    });
    this.pipe(child.stderr, state.err, options.maxBufferBytes, () => {
      state.overflowed = true;
      terminate();
    });

    return {
      clear: (): void => {
        clearTimeout(timer);
        if (giveUpTimer !== undefined) {
          clearTimeout(giveUpTimer);
        }
        options.signal?.removeEventListener('abort', onAbort);
      },
      terminate,
      onGiveUp: (callback: () => void): void => {
        onGiveUp = callback;
      },
    };
  }

  /**
   * 构造一次 spawn 调用（PTY 形态经 GNU `script` 包一层）。
   *
   * @param command 命令文本。
   * @param options 执行参数（只用 `pty`）。
   * @returns 可执行文件与 argv。
   * @throws 当前平台不可用 PTY 时（由 {@link run} 的 try/catch 转成 reject，上层 fail-closed）。
   */
  private static invocationOf(
    command: string,
    options: ShellRunOptions,
  ): { readonly bin: string; readonly args: readonly string[] } {
    if (options.pty ?? false) {
      // PTY 形态：用 GNU `script` 包一层（见 ShellInvocation.ptyCommand）。
      // 该调用在当前平台不可用时**同步抛出**，落到 run 的 catch 转成 reject（上层 fail-closed）。
      return ShellInvocation.ptyCommand(command);
    }
    const shell = ShellInvocation.path();
    return { bin: shell, args: ShellInvocation.args(shell, command) };
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
