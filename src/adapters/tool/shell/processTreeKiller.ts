/**
 * 子进程**树**终止（超时 / 输出超限 / 会话取消三条路径共用）。
 *
 * 为什么需要它（审计 §1.7）：此前终止只调 `child.kill('SIGKILL')`，杀掉的是**直接子进程**——
 * 也就是 shell 解释器本身（`cmd.exe` / `sh`）。而命令真正的载荷（`npm test` → `node`，
 * 或 `cmd /c a && b` 的第二个命令）是它的**子进程**：在 Windows 上 `TerminateProcess` 不会连带
 * 后代，于是「已超时/已取消」的回合背后仍有一棵进程树在跑（占 CPU、占文件锁、可能继续改工作区）。
 *
 * 分平台策略：
 * - **Windows**：`taskkill /PID <pid> /T /F` 能连带整棵树；它不是系统必备之外的依赖，
 *   失败（权限不足 / 进程已退出）时**回退**到 `child.kill('SIGKILL')`——尽力而为但不假装成功。
 * - **POSIX**：直接子进程一般是会话组长（我们以 `spawn` 默认形态启动 shell），
 *   故先试 `process.kill(-pid, 'SIGKILL')` 杀**进程组**，失败再回退单进程 kill。
 *
 * 失败一律**不抛错**：终止属收尾路径，让它把已经拿到的结果毁掉是本末倒置
 * （与 `ChromeProcess.kill` 的既有取舍一致）。
 */

import { execFileSync, spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { log } from '../../../util/logger.js';

/**
 * 注入缝（**仅供判据**）：三个键全部可选，缺省即本文件原本的 `process.platform` /
 * `process.kill` / `execFileSync` / `spawn`，故不传 `opts` 时行为逐字不变。
 *
 * 只留这一个缝，是为了让「分平台回退分支」在本机（win32）也可判真伪：
 * 没有它，POSIX 组杀与 EPERM/ESRCH 回退只能靠读代码相信。
 */
export interface ProcessTreeKillerOptions {
  /** 平台标识（缺省 `process.platform`）。 */
  readonly platform?: string;
  /** 单进程/进程组终止实现（缺省 `process.kill`）。 */
  readonly kill?: (pid: number, signal: NodeJS.Signals | number) => boolean;
  /** 同步执行器（缺省 `execFileSync`），仅 Windows `killPid` 分支使用。 */
  readonly exec?: typeof execFileSync;
  /** 异步 spawn（缺省 `spawn`），仅 Windows `kill` 分支使用。 */
  readonly spawn?: typeof spawn;
}

/** 子进程树终止器。 */
export class ProcessTreeKiller {
  /** 同步 taskkill 的上限（毫秒）：超时即放弃（进程可能已退出）。 */
  private static readonly TASKKILL_TIMEOUT_MS = 5_000;

  /**
   * 终止一棵进程树（幂等；进程已退出或权限不足时静默回退）。
   * @param child 待终止的子进程（其 `pid` 可能已回收/为空）。
   * @param opts 注入缝（缺省即真实平台与真实系统调用）。
   * @returns 无返回值。
   */
  public static kill(child: ChildProcess, opts: ProcessTreeKillerOptions = {}): void {
    const pid = child.pid;
    if (pid === undefined) {
      // 尚未 spawn 成功（无 pid）：只能走单进程 kill（此时通常也无实体）。
      try {
        child.kill('SIGKILL');
      } catch {
        /* 已退出 */
      }
      return;
    }
    if ((opts.platform ?? process.platform) === 'win32') {
      ProcessTreeKiller.killTreeWindows(pid, child, opts);
      return;
    }
    const kill = opts.kill ?? process.kill;
    try {
      // 负 pid = 进程组（spawn 默认让子进程成为组长）；成功即整组被终结。
      kill(-pid, 'SIGKILL');
    } catch (error) {
      log.debug('shell.killTree.groupFailed', { pid, error: String(error) });
      try {
        child.kill('SIGKILL');
      } catch {
        /* 已退出 */
      }
    }
  }

  /**
   * 按 **pid** 终止一棵进程树（不需要 `ChildProcess` 句柄的场景，如 detached 后台作业）。
   *
   * 与 {@link ProcessTreeKiller.kill} 同一分平台策略；只持有 pid 的调用方（后台作业注册表）
   * 原先用 `process.kill(pid,'SIGTERM')` —— Windows 上那只终结外壳，真正的载荷树会继续跑。
   * @param pid 目标进程 pid。
   * @param opts 注入缝（缺省即真实平台与真实系统调用）。
   * @returns 无返回值（失败静默，与 `kill` 同一取舍）。
   */
  public static killPid(pid: number, opts: ProcessTreeKillerOptions = {}): void {
    if ((opts.platform ?? process.platform) === 'win32') {
      try {
        // **同步**执行：`kill` 的调用方（后台作业注册表）紧接着就可能清理工作目录/日志文件，
        // 异步 taskkill 会让「已开启的子进程句柄」多存活一小段时间 ⇒ 调用方 `rmdir` 撞 EBUSY。
        // 终止属收尾路径，阻塞几十毫秒可接受，换来的是「kill 返回即已死」的可依赖语义。
        (opts.exec ?? execFileSync)('taskkill', ['/PID', String(pid), '/T', '/F'], {
          stdio: 'ignore',
          timeout: ProcessTreeKiller.TASKKILL_TIMEOUT_MS,
        });
      } catch (error) {
        log.debug('shell.killTree.taskkillPidFailed', { pid, error: String(error) });
      }
      return;
    }
    const kill = opts.kill ?? process.kill;
    try {
      // detached 子进程是会话组长 ⇒ 负 pid 即整组。
      kill(-pid, 'SIGKILL');
    } catch {
      try {
        kill(pid, 'SIGKILL');
      } catch {
        /* 已退出 */
      }
    }
  }

  /**
   * Windows：`taskkill /T /F` 连带后代；失败回退单进程 kill。
   * @param pid 直接子进程 pid。
   * @param child 子进程句柄（回退用）。
   * @param opts 注入缝。
   * @returns 无返回值。
   */
  private static killTreeWindows(
    pid: number,
    child: ChildProcess,
    opts: ProcessTreeKillerOptions,
  ): void {
    try {
      const killer = (opts.spawn ?? spawn)('taskkill', ['/PID', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
      killer.on('error', (error: Error) => {
        log.debug('shell.killTree.taskkillFailed', { pid, error: String(error) });
        ProcessTreeKiller.fallbackKill(child);
      });
    } catch (error) {
      log.debug('shell.killTree.taskkillThrew', { pid, error: String(error) });
      ProcessTreeKiller.fallbackKill(child);
    }
  }

  /**
   * 回退：只杀直接子进程（尽力而为）。
   * @param child 子进程句柄。
   * @returns 无返回值。
   */
  private static fallbackKill(child: ChildProcess): void {
    try {
      child.kill('SIGKILL');
    } catch {
      /* 已退出 */
    }
  }
}
