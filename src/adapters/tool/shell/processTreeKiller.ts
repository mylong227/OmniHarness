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

import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { log } from '../../../util/logger.js';

/** 子进程树终止器。 */
export class ProcessTreeKiller {
  /**
   * 终止一棵进程树（幂等；进程已退出或权限不足时静默回退）。
   * @param child 待终止的子进程（其 `pid` 可能已回收/为空）。
   * @returns 无返回值。
   */
  public static kill(child: ChildProcess): void {
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
    if (process.platform === 'win32') {
      ProcessTreeKiller.killTreeWindows(pid, child);
      return;
    }
    try {
      // 负 pid = 进程组（spawn 默认让子进程成为组长）；成功即整组被终结。
      process.kill(-pid, 'SIGKILL');
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
   * Windows：`taskkill /T /F` 连带后代；失败回退单进程 kill。
   * @param pid 直接子进程 pid。
   * @param child 子进程句柄（回退用）。
   * @returns 无返回值。
   */
  private static killTreeWindows(pid: number, child: ChildProcess): void {
    try {
      const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
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
