/**
 * 常驻 daemon 控制器（D3）：以 PID 文件管理后台 serve 进程。
 *
 * - start：以 detached 方式后台拉起 `serve`（进程独立、父退出不连带），写 PID 文件。
 * - stop：读 PID 文件、发送 SIGTERM，删除 PID 文件（fail-open：无文件静默返回）。
 * - status：探测 PID 文件 + 进程存活（kill(pid,0)）。
 * 多会话由常驻的 serve（AppServer 原生支持多会话）承接——daemon 只负责「常驻」。
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

/**
 * @beta
 */
export interface DaemonStatus {
  readonly running: boolean;
  readonly pid?: number | undefined;
}

/**
 * @beta
 */
export class DaemonController {
  /** PID 文件路径（缺省 ~/.omniharness/daemon.pid，可覆盖）。 */
  private readonly pidFile: string;
  /** serve 入口脚本路径（后台进程以它重新拉起）。 */
  private readonly entry: string;

  /**
   * 创建控制器。
   * @param opts 可选项（pidFile 与入口路径，缺省按用户主目录与当前模块推导）
   */
  public constructor(opts?: { pidFile?: string; entry?: string }) {
    const home = homedir();
    this.pidFile = opts?.pidFile ?? resolve(home, '.omniharness', 'daemon.pid');
    this.entry = opts?.entry ?? fileURLToPath(import.meta.url);
  }

  /**
   * 当前状态：PID 文件存在且进程存活才视为 running。
   * @returns `{ running, pid? }` — 存活时带 PID。
   */
  public status(): DaemonStatus {
    if (!existsSync(this.pidFile)) {
      return { running: false };
    }
    const raw = readFileSync(this.pidFile, 'utf8').trim();
    const pid = Number.parseInt(raw, 10);
    if (Number.isNaN(pid)) {
      return { running: false };
    }
    const alive = this.isAlive(pid);
    return { running: alive, pid: alive ? pid : undefined };
  }

  /**
   * 进程存活探测（signal 0 只检测存在性，不真正发信号）。
   * @param pid 待探测的进程 id。
   * @returns 进程存在返回 true。
   */
  private isAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 启动常驻 serve（detached 后台）。已在运行则返回现有 PID。
   * @param serveArgs 透传给 serve 的附加参数。
   * @param port 监听端口（缺省 8787）。
   * @returns 后台进程 PID（同时写入 PID 文件）。
   */
  public start(serveArgs: readonly string[], port = 8787): number {
    const st = this.status();
    if (st.running && st.pid !== undefined) {
      return st.pid;
    }
    mkdirSync(dirname(this.pidFile), { recursive: true });
    const child = spawn(
      process.execPath,
      [this.entry, 'serve', '--port', String(port), ...serveArgs],
      { detached: true, stdio: 'ignore', env: process.env },
    );
    child.unref();
    const pid = child.pid;
    if (pid === undefined) {
      throw new Error('daemon 启动失败：未能获取子进程 PID');
    }
    writeFileSync(this.pidFile, String(pid), 'utf8');
    return pid;
  }

  /**
   * 停止常驻 serve。无 PID 文件时静默返回 false。
   * @returns 是否真的停止了一个运行中的进程（SIGTERM 后清理 PID 文件）。
   */
  public stop(): boolean {
    const st = this.status();
    if (!st.running || st.pid === undefined) {
      if (existsSync(this.pidFile)) {
        unlinkSync(this.pidFile);
      }
      return false;
    }
    try {
      process.kill(st.pid, 'SIGTERM');
    } catch {
      // 已被回收，忽略。
    }
    if (existsSync(this.pidFile)) {
      unlinkSync(this.pidFile);
    }
    return true;
  }
}
