/**
 * 验证命令执行器（长时程协议与长任务评测共用，2026-10-24）。
 *
 * 为什么单独成一个类：`LongHorizonProtocol.verify()`（上下文层）与 `LongTaskVerify`（评测层）
 * 都要「在受控预算内跑一条用户/任务声明的验证命令，并拿到退出码 / 输出 / 是否超时」。两处若各写
 * 一份 spawn 逻辑，超时语义（是否真的杀进程、是否等 close）必然漂移 —— 判据会因此给出不同结论。
 *
 * 取向：
 *  - **不抛异常**：spawn 失败（工具链缺失）也回 `ran:false`，由调用方决定 fail-open 还是 fail-closed；
 *  - **有界**：超时即终止进程树（POSIX 杀进程组、Windows 用 `taskkill /T`），输出按字节上限截断；
 *  - **零第三方依赖**：只用 node 内置模块。
 */

import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';

/** 单次验证执行结果（全部状态显式回传，不靠异常表达）。 */
export interface VerifyCommandOutcome {
  /** 命令是否真的被 spawn 起来（工具链缺失时为 false）。 */
  readonly ran: boolean;
  /** 退出码为 0 且未超时时为 true（`ran:false` 时恒为 false）。 */
  readonly ok: boolean;
  /** 退出码（被终止/未执行时为 null）。 */
  readonly exitCode: number | null;
  /** stdout + stderr 合并文本（超限已截断）。 */
  readonly output: string;
  /** 是否因超时被终止。 */
  readonly timedOut: boolean;
  /** 输出是否因超过字节上限被截断。 */
  readonly truncated: boolean;
  /** spawn 层面的错误信息（未执行/异常退出时给可读原因；成功时为 undefined）。 */
  readonly error: string | undefined;
}

/** 输出累积状态（stdout / stderr 共用一个上限，避免两路各 64KB 撑爆报告）。 */
interface OutputState {
  readonly chunks: Buffer[];
  bytes: number;
  truncated: boolean;
}

/**
 * 受控验证命令执行器（无状态，可复用）。
 */
export class VerifyCommandRunner {
  /** 缺省超时（毫秒）：验证命令不该把回合挂住。 */
  public static readonly DEFAULT_TIMEOUT_MS = 120_000;
  /** 缺省输出上限（字节）：验证只需要失败摘要，不需要全量日志。 */
  public static readonly DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024;

  /**
   * 在受控预算内执行一条命令。
   *
   * @param command 命令文本（调用方负责来源校验；本类只执行）。
   * @param cwd 工作目录（仓库根）。
   * @param timeoutMs 超时（毫秒；<=0 时用缺省值）。
   * @param maxOutputBytes 合并输出上限（字节；<=0 时用缺省值）。
   * @returns 执行结果（含退出码 / 输出 / 是否超时 / 是否真的跑起来）。
   */
  public static async run(
    command: string,
    cwd: string,
    timeoutMs = VerifyCommandRunner.DEFAULT_TIMEOUT_MS,
    maxOutputBytes = VerifyCommandRunner.DEFAULT_MAX_OUTPUT_BYTES,
  ): Promise<VerifyCommandOutcome> {
    const budget = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 120_000;
    const cap =
      Number.isFinite(maxOutputBytes) && maxOutputBytes > 0
        ? maxOutputBytes
        : VerifyCommandRunner.DEFAULT_MAX_OUTPUT_BYTES;
    const state: OutputState = { chunks: [], bytes: 0, truncated: false };
    return new Promise<VerifyCommandOutcome>((resolve) => {
      let child: ChildProcess;
      try {
        child = spawn(command, {
          cwd,
          env: process.env,
          shell: true,
          stdio: ['ignore', 'pipe', 'pipe'],
          detached: process.platform !== 'win32',
          windowsHide: true,
        });
      } catch (error) {
        resolve(VerifyCommandRunner.notRun(error));
        return;
      }
      let settled = false;
      // 用容器持有定时器：`finish` 与超时回调互相引用，容器让「先定义后赋值」不必用可重赋值的 let。
      const deadline: { handle?: ReturnType<typeof setTimeout> } = {};
      const finish = (exitCode: number | null, timedOut: boolean, error?: string): void => {
        if (settled) return;
        settled = true;
        if (deadline.handle !== undefined) clearTimeout(deadline.handle);
        child.stdout?.destroy();
        child.stderr?.destroy();
        const output = Buffer.concat(state.chunks).toString('utf8');
        resolve({
          ran: true,
          ok: exitCode === 0 && !timedOut,
          exitCode,
          output,
          timedOut,
          truncated: state.truncated,
          error,
        });
      };
      VerifyCommandRunner.collect(child.stdout, state, cap);
      VerifyCommandRunner.collect(child.stderr, state, cap);
      deadline.handle = setTimeout(() => {
        VerifyCommandRunner.terminate(child);
        finish(null, true, `验证命令超时（${String(budget)}ms）`);
      }, budget);
      child.on('error', (error: Error) => {
        finish(null, false, error.message);
      });
      child.on('close', (code: number | null) => {
        finish(code, false);
      });
    });
  }

  /**
   * 收集一路输出，超限即停止累积（不杀进程：验证命令的失败摘要够用）。
   * @param stream 子进程输出流（可能为 null）。
   * @param state 合并累积状态。
   * @param cap 合并字节上限。
   * @returns 无返回值。
   */
  private static collect(
    stream: NodeJS.ReadableStream | null,
    state: OutputState,
    cap: number,
  ): void {
    if (stream === null || stream === undefined) return;
    stream.on('data', (chunk: Buffer | string) => {
      const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      if (state.bytes + buffer.length > cap) {
        const room = Math.max(0, cap - state.bytes);
        if (room > 0) state.chunks.push(buffer.subarray(0, room));
        state.bytes = cap;
        state.truncated = true;
        return;
      }
      state.chunks.push(buffer);
      state.bytes += buffer.length;
    });
  }

  /**
   * 终止进程树：POSIX 杀进程组（spawn 时已 detached），Windows 用 `taskkill /T`。
   * @param child 子进程句柄。
   * @returns 无返回值。
   */
  private static terminate(child: ChildProcess): void {
    const pid = child.pid;
    if (pid === undefined) {
      try {
        child.kill('SIGKILL');
      } catch {
        /* 已经退出 */
      }
      return;
    }
    if (process.platform === 'win32') {
      try {
        spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
      } catch {
        /* taskkill 不可用时退化为只杀直接子进程 */
      }
      try {
        child.kill('SIGKILL');
      } catch {
        /* 已经退出 */
      }
      return;
    }
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      try {
        child.kill('SIGKILL');
      } catch {
        /* 已经退出 */
      }
    }
  }

  /**
   * 把 spawn 同步异常包装成 `ran:false` 结果。
   * @param error 捕获到的异常。
   * @returns 未执行结果。
   */
  private static notRun(error: unknown): VerifyCommandOutcome {
    return {
      ran: false,
      ok: false,
      exitCode: null,
      output: '',
      timedOut: false,
      truncated: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
