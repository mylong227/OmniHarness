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
  /** SIGTERM 后等待进程自行退出的上限（毫秒）。 */
  private static readonly STOP_TIMEOUT_MS = 5_000;
  /** 树杀兜底后等待进程消失的上限（毫秒）。 */
  private static readonly KILL_TIMEOUT_MS = 3_000;
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
    this.entry = opts?.entry ?? DaemonController.defaultEntry();
  }

  /**
   * 默认后台入口：CLI 可执行入口（`dist/src/cli/exec.js`），**不是本文件**。
   *
   * 历史缺陷：构造函数曾用 `fileURLToPath(import.meta.url)`（即 daemonController 自身）
   * 当入口——那个文件没有顶层执行逻辑，`daemon start` 永远起不了 serve，却照样写 PID 并
   * 打印"已启动"。这里按相对模块位置推导 CLI 入口，并用公开静态方法让判据能钉住。
   * @returns CLI 入口的绝对路径
   */
  public static defaultEntry(): string {
    return resolve(dirname(fileURLToPath(import.meta.url)), '..', 'cli', 'exec.js');
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
    // 就绪探测：入口不存在/端口被占时子进程会立刻退出，旧实现照样写 PID 并让 CLI
    // 打印“已启动”（用户按假成功继续连 UI）。这里给一个很短的存活窗口，失败即抛错。
    if (!this.waitForAlive(pid, 800)) {
      throw new Error(
        `daemon 启动失败：子进程 ${String(pid)} 启动后立即退出（检查入口是否存在、端口是否被占用）`,
      );
    }
    writeFileSync(this.pidFile, String(pid), 'utf8');
    return pid;
  }

  /**
   * 等待进程**稳定存活**一个短窗口（同步 sleep；仅 start 的就绪探测用）。
   * @param pid 目标进程 id
   * @param timeoutMs 观察窗口毫秒数
   * @returns 窗口结束时仍存活返回 true；中途退出返回 false
   */
  private waitForAlive(pid: number, timeoutMs: number): boolean {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!this.isAlive(pid)) return false;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
    return this.isAlive(pid);
  }

  /**
   * 停止常驻 serve。无 PID 文件时静默返回 false。
   *
   * 顺序有讲究（2026-09-26 审计 S23）：先 SIGTERM，**等进程真的退出**（轮询 `isAlive` 到截止），
   * 超时则树杀兜底（Windows 上 SIGTERM 只终结外壳，孙进程会继续占着端口），最后才删 PID 文件。
   * 旧实现发完信号立即 unlink ⇒ `status()` 谎报「未运行」，而进程仍活着占端口，于是下一次
   * `start()` 又拉起第二个 daemon。
   * @returns 是否真的停止了一个运行中的进程。
   */
  public stop(): boolean {
    const st = this.status();
    if (!st.running || st.pid === undefined) {
      if (existsSync(this.pidFile)) {
        unlinkSync(this.pidFile);
      }
      return false;
    }
    const pid = st.pid;
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // 已被回收，忽略。
    }
    let exited = this.waitForExit(pid, DaemonController.STOP_TIMEOUT_MS);
    if (!exited) {
      DaemonController.forceKillTree(pid);
      exited = this.waitForExit(pid, DaemonController.KILL_TIMEOUT_MS);
    }
    if (!exited) {
      // 树杀后仍存活：**不得删 PID 文件、不得报成功**。旧实现无条件 unlink + true，
      // 用户看到“已停止”，进程仍占端口，下一次 start 又拉第二个 daemon。
      return false;
    }
    if (existsSync(this.pidFile)) {
      unlinkSync(this.pidFile);
    }
    return true;
  }

  /**
   * 轮询等待进程退出（同步 sleep 自旋：stop 是 CLI 一次性动作，不需要事件循环让位）。
   * @param pid 目标进程 id。
   * @param timeoutMs 最长等待毫秒数。
   * @returns 已退出返回 true；超时仍存活返回 false。
   */
  private waitForExit(pid: number, timeoutMs: number): boolean {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!this.isAlive(pid)) {
        return true;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
    return !this.isAlive(pid);
  }

  /**
   * 树杀兜底：Windows 用 `taskkill /T /F`（连带孙进程），其余平台退化为 SIGKILL。
   * @param pid 目标进程 id。
   * @returns 无返回值（失败静默——清理失败不该让 stop 抛错）。
   */
  private static forceKillTree(pid: number): void {
    try {
      if (process.platform === 'win32') {
        spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
        return;
      }
      // 杀整个进程组（负 pid = 组），避免 detached 子进程的孙进程残留继续占端口；
      // 组不存在时回退到只杀直接子进程。
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        process.kill(pid, 'SIGKILL');
      }
    } catch {
      /* 进程可能已退出 */
    }
  }
}
