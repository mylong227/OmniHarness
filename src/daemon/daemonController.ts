/**
 * 常驻 daemon 控制器（D3）：以 PID 文件管理后台 serve 进程。
 *
 * - start：以 detached 方式后台拉起 `serve`（进程独立、父退出不连带），写 PID 文件。
 * - stop：读 PID 文件、发送 SIGTERM，删除 PID 文件（fail-open：无文件静默返回）。
 * - status：探测 PID 文件 + 进程存活（kill(pid,0)）。
 * 多会话由常驻的 serve（AppServer 原生支持多会话）承接——daemon 只负责「常驻」。
 */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OmniHome } from '../util/omniHome.ts';
import { log } from '../util/logger.ts';

/** PID 文件记录：pid + 进程启动时刻（毫秒，尽力采集；旧文件只有 pid）。 */
interface DaemonRecord {
  readonly pid: number;
  readonly startedAt?: number | undefined;
}

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
  /** 就绪观察窗口（毫秒，默认 800；见构造函数注释）。 */
  private readonly probeMs: number;

  /**
   * 创建控制器。
   * @param opts 可选项（pidFile / 入口路径 / 就绪观察窗口，缺省按用户主目录与当前模块推导）
   */
  public constructor(opts?: { pidFile?: string; entry?: string; probeMs?: number }) {
    this.pidFile = opts?.pidFile ?? join(OmniHome.dir(), 'daemon.pid');
    this.entry = opts?.entry ?? DaemonController.defaultEntry();
    // 就绪观察窗口抽成可注入项的唯一原因是**判据可确定性**：满载机器上"入口不存在 ⇒
    // 子进程立刻退出"可能要 >800ms 才被调度到，同步窗口一到就判存活 ⇒ 测试偶发红
    // （2026-10-18 全量并行实测一次）。产品默认值不变，测试传更大的窗口。
    this.probeMs = opts?.probeMs ?? 800;
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
    const record = this.readRecord();
    if (record === undefined) {
      return { running: false };
    }
    const alive = this.isAlive(record.pid);
    return { running: alive, pid: alive ? record.pid : undefined };
  }

  /**
   * 读 PID 文件（兼容旧版纯数字格式）。
   * @returns 记录；文件不存在/格式非法时为 undefined。
   */
  private readRecord(): DaemonRecord | undefined {
    if (!existsSync(this.pidFile)) return undefined;
    const raw = readFileSync(this.pidFile, 'utf8').trim();
    if (raw.startsWith('{')) {
      try {
        const parsed = JSON.parse(raw) as { pid?: unknown; startedAt?: unknown };
        if (typeof parsed.pid === 'number' && Number.isInteger(parsed.pid) && parsed.pid > 0) {
          return {
            pid: parsed.pid,
            ...(typeof parsed.startedAt === 'number' && Number.isFinite(parsed.startedAt)
              ? { startedAt: parsed.startedAt }
              : {}),
          };
        }
      } catch {
        return undefined;
      }
      return undefined;
    }
    const pid = Number.parseInt(raw, 10);
    return Number.isInteger(pid) && pid > 0 ? { pid } : undefined;
  }

  /**
   * 采集进程启动时刻（毫秒）。尽力而为：拿不到时返回 undefined，stop 会拒绝盲杀。
   * @param pid 目标进程 id
   * @returns 启动时刻毫秒；平台不支持/读取失败时为 undefined
   */
  private processStartMs(pid: number): number | undefined {
    try {
      if (process.platform === 'win32') {
        const out = execFileSync(
          'powershell',
          [
            '-NoProfile',
            '-Command',
            `(Get-Process -Id ${String(pid)} -ErrorAction Stop).StartTime.ToUniversalTime().ToFileTimeUtc()`,
          ],
          { encoding: 'utf8', timeout: 15000, windowsHide: true },
        ).trim();
        const fileTime = Number(out);
        if (!Number.isFinite(fileTime)) return undefined;
        // FILETIME = 100ns since 1601-01-01；转 Unix epoch 毫秒。
        return Math.round(fileTime / 10_000 - 11_644_473_600_000);
      }
      if (process.platform === 'linux') {
        const stat = readFileSync(`/proc/${String(pid)}/stat`, 'utf8');
        const close = stat.lastIndexOf(')');
        if (close < 0) return undefined;
        // state 为第 3 字段（index 0），starttime 为第 22 字段（index 19）。
        const fields = stat
          .slice(close + 1)
          .trim()
          .split(/\s+/u);
        const ticks = Number(fields[19]);
        if (!Number.isFinite(ticks)) return undefined;
        const procStat = readFileSync('/proc/stat', 'utf8');
        const boot = /^btime (\d+)$/mu.exec(procStat)?.[1];
        if (boot === undefined) return undefined;
        return Number(boot) * 1000 + ticks * 10;
      }
      if (process.platform === 'darwin') {
        const out = execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], {
          encoding: 'utf8',
          timeout: 15000,
        }).trim();
        const ms = Date.parse(out);
        return Number.isFinite(ms) ? ms : undefined;
      }
      return undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * 带重试的启动时刻采集：全量套件高负载下 PowerShell/WMI 可能单次超时；
   * 采集不到指纹会让 stop 拒绝执行（宁可失败也不误杀），故给两三次短重试。
   * @param pid 目标进程 id
   * @returns 启动时刻毫秒；连续失败时为 undefined
   */
  private processStartMsStable(pid: number): number | undefined {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const value = this.processStartMs(pid);
      if (value !== undefined) return value;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
    }
    return undefined;
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
    if (!this.waitForAlive(pid, this.probeMs)) {
      throw new Error(
        `daemon 启动失败：子进程 ${String(pid)} 启动后立即退出（检查入口是否存在、端口是否被占用）`,
      );
    }
    // 记录 PID + 启动时刻：stop 前据此判断 PID 是否被复用（旧文件只有 pid，兼容保留）。
    const startedAt = this.processStartMsStable(pid);
    writeFileSync(
      this.pidFile,
      JSON.stringify(startedAt === undefined ? { pid } : { pid, startedAt }),
      'utf8',
    );
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
    const record = this.readRecord();
    if (record === undefined || !this.isAlive(record.pid)) {
      if (existsSync(this.pidFile)) {
        unlinkSync(this.pidFile);
      }
      return false;
    }
    // 身份校验：陈旧 PID 文件可能已被系统复用给无关进程。此时**绝不能杀**；能确认不匹配
    // 就清理陈旧文件，读不到启动时刻则保守返回 false（保留文件，避免误判后重启双 daemon）。
    if (record.startedAt !== undefined) {
      const actual = this.processStartMsStable(record.pid);
      if (actual === undefined) {
        log.warn('daemon.pid.unverifiable', { pid: record.pid });
        return false;
      }
      if (Math.abs(actual - record.startedAt) > 10_000) {
        log.warn('daemon.pid.reused', {
          pid: record.pid,
          expectedStartedAt: record.startedAt,
          actualStartedAt: actual,
        });
        unlinkSync(this.pidFile);
        return false;
      }
    }
    const pid = record.pid;
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
