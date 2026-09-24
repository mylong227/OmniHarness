/**
 * 后台作业注册表（P2-⑫）：把长时命令从「单发 + 30s 顶」里解放出来。
 *
 * 为什么需要：`shell` 是**同步等待**模型——跑一次全量测试/安装依赖要几分钟，
 * 前台等待既烧上下文也容易被超时误杀。后台作业把命令的**生命周期与工具调用解耦**：
 * 立刻返回作业 id，之后用 `shell_job` 按需取输出。
 *
 * 实现要点：
 * - `detached: true` + `unref()` ⇒ 子进程不随宿主退出而终止（这正是「长时」的意义）；
 * - stdout/stderr 直接重定向到 `<workdir>/.omniharness/jobs/<id>.log`（无内存累积，
 *   输出多大都不会撑爆进程内存）；
 * - 退出码靠 `exit` 事件尽力记录 —— 宿主若先退出就观察不到，此时 `status` 显示 `running`，
 *   调用方以**日志内容**为准（本仓不假装知道未知的事）。
 */

import { spawn } from 'node:child_process';
import { closeSync, fstatSync, mkdirSync, openSync, readSync } from 'node:fs';
import { join } from 'node:path';
import { ShellInvocation } from './shellInvocation.js';

/** 单个后台作业的可观测状态。 */
export interface BackgroundJob {
  /** 作业 id（短、稳定、可读，如 `bg-1`）。 */
  readonly id: string;
  /** 子进程 pid（spawn 失败时为 `undefined`）。 */
  readonly pid: number | undefined;
  /** 原始命令文本。 */
  readonly command: string;
  /** 输出日志文件绝对路径（stdout + stderr 合流）。 */
  readonly logFile: string;
  /** 启动时刻（毫秒时间戳）。 */
  readonly startedAt: number;
  /** 状态：运行中 / 已退出 / 已被 kill。 */
  readonly status: 'running' | 'exited' | 'killed';
  /** 退出码（未知时为 `null`）。 */
  readonly exitCode: number | null;
}

/** 内部可变记录（对外只暴露不可变的 {@link BackgroundJob} 快照）。 */
interface MutableJob {
  readonly id: string;
  readonly pid: number | undefined;
  readonly command: string;
  readonly logFile: string;
  readonly startedAt: number;
  status: 'running' | 'exited' | 'killed';
  exitCode: number | null;
}

/**
 * 后台作业注册表（进程内）。
 */
export class BackgroundJobRegistry {
  /** 同时保留的作业上限（超出时淘汰最早的**已结束**作业）。 */
  public static readonly MAX_JOBS = 20;

  /** 日志文件所在目录（`.omniharness/jobs`，已在 .gitignore 内）。 */
  private readonly logDir: string;
  /** 全部作业（保持插入顺序，便于按时间淘汰）。 */
  private readonly jobs = new Map<string, MutableJob>();
  /** 自增序号（作业 id 后缀）。 */
  private seq = 0;

  /**
   * @param workRoot 工作区根（日志落在其下 `.omniharness/jobs/`）。
   */
  public constructor(private readonly workRoot: string) {
    this.logDir = join(workRoot, '.omniharness', 'jobs');
  }

  /**
   * 启动一个后台作业。
   *
   * @param command 命令文本（调用方已完成策略裁决）。
   * @param env 子进程环境变量。
   * @returns 新作业的不可变快照。
   * @throws 作业数已达上限且无已结束作业可淘汰时抛错。
   */
  public start(command: string, env: NodeJS.ProcessEnv): BackgroundJob {
    this.evictIfNeeded();
    mkdirSync(this.logDir, { recursive: true });
    this.seq += 1;
    const id = `bg-${String(this.seq)}`;
    const logFile = join(this.logDir, `${id}.log`);
    const fd = openSync(logFile, 'a');
    let pid: number | undefined;
    try {
      const shell = ShellInvocation.path();
      const child = spawn(shell, ShellInvocation.args(shell, command), {
        cwd: this.workRoot,
        env,
        detached: true,
        windowsHide: true,
        // 与前台同一口径：cmd 形态的命令串自带引号，须原样传递（审计 §1.9）。
        windowsVerbatimArguments: ShellInvocation.needsVerbatimArgs(shell),
        stdio: ['ignore', fd, fd],
      });
      pid = child.pid;
      const job: MutableJob = {
        id,
        pid,
        command,
        logFile,
        startedAt: Date.now(),
        status: 'running',
        exitCode: null,
      };
      this.jobs.set(id, job);
      child.on('exit', (code: number | null) => {
        if (job.status === 'running') {
          job.status = 'exited';
          job.exitCode = code;
        }
      });
      // detached + unref：父进程退出不带走子进程（「长时命令」的本义）。
      child.unref();
      return BackgroundJobRegistry.snapshot(job);
    } finally {
      closeSync(fd);
    }
  }

  /**
   * 读取作业日志的**尾部**若干字节。
   *
   * @param id 作业 id。
   * @param maxBytes 最多返回的字节数（≤0 时取 1）。
   * @returns 日志尾部文本；作业不存在时返回 `undefined`；日志尚未产生时返回空串。
   */
  public output(id: string, maxBytes: number): string | undefined {
    const job = this.jobs.get(id);
    if (job === undefined) {
      return undefined;
    }
    const cap = maxBytes > 0 ? Math.floor(maxBytes) : 1;
    const fd = openSync(job.logFile, 'r');
    try {
      const size = fstatSync(fd).size;
      const length = Math.min(size, cap);
      if (length <= 0) {
        return '';
      }
      const buffer = Buffer.alloc(length);
      readSync(fd, buffer, 0, length, size - length);
      return buffer.toString('utf8');
    } catch {
      return '';
    } finally {
      closeSync(fd);
    }
  }

  /**
   * 取单个作业的状态快照。
   *
   * @param id 作业 id。
   * @returns 作业快照；不存在时返回 `undefined`。
   */
  public status(id: string): BackgroundJob | undefined {
    const job = this.jobs.get(id);
    return job === undefined ? undefined : BackgroundJobRegistry.snapshot(job);
  }

  /**
   * 终止作业（尽力而为：Windows 上只保证终结 shell 本体，孙进程可能存活）。
   *
   * @param id 作业 id。
   * @returns 找到并发出终止信号时为 true；作业不存在或 pid 未知时为 false。
   */
  public kill(id: string): boolean {
    const job = this.jobs.get(id);
    if (job === undefined || job.pid === undefined) {
      return false;
    }
    try {
      process.kill(job.pid, 'SIGTERM');
      job.status = 'killed';
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 列出全部作业（按启动顺序）。
   *
   * @returns 作业快照列表。
   */
  public list(): readonly BackgroundJob[] {
    return [...this.jobs.values()].map((job) => BackgroundJobRegistry.snapshot(job));
  }

  /**
   * 淘汰最早的**已结束**作业以腾出容量。
   *
   * @returns 无返回值。
   * @throws 无已结束作业可淘汰且已满时抛错。
   */
  private evictIfNeeded(): void {
    if (this.jobs.size < BackgroundJobRegistry.MAX_JOBS) {
      return;
    }
    for (const [id, job] of this.jobs) {
      if (job.status !== 'running') {
        this.jobs.delete(id);
        return;
      }
    }
    throw new Error(
      `后台作业数已达上限 ${String(BackgroundJobRegistry.MAX_JOBS)}，且无已结束作业可回收。` +
        '请先 kill 或等待现有作业结束。',
    );
  }

  /**
   * 生成不可变快照（对外不暴露内部可变记录）。
   *
   * @param job 内部记录。
   * @returns 不可变快照。
   */
  private static snapshot(job: MutableJob): BackgroundJob {
    return {
      id: job.id,
      pid: job.pid,
      command: job.command,
      logFile: job.logFile,
      startedAt: job.startedAt,
      status: job.status,
      exitCode: job.exitCode,
    };
  }
}
