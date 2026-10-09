import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { WorkflowSpecError } from './workflowSpecError.js';

/** 运行目录（与运行日志同目录，锁文件与 `<runId>.jsonl` 并排）。 */
const RUN_DIR = '.omniharness/graph-runs';

/**
 * 视为「陈旧锁」的年龄上限（毫秒）。
 *
 * 语义：超过它即认定持锁进程已死（哪怕同机 PID 探测因权限/容器等原因不可靠）。取 6 小时——
 * 单次图运行远达不到（步骤受 `maxSteps` 与预算约束），而它同时兜住「跨主机共享目录（PID 探测无效）」
 * 这一无法用 PID 判活的场景，避免死锁永久化。
 */
const STALE_LOCK_MS = 6 * 60 * 60 * 1000;

/** 锁文件内容（自描述，便于人排查「谁占着」）。 */
export interface WorkflowRunLockInfo {
  /** 持锁进程 id。 */
  readonly pid: number;
  /** 持锁主机名（跨主机时 PID 探测无效，只能靠年龄判定）。 */
  readonly host: string;
  /** 加锁时刻（ISO）。 */
  readonly at: string;
  /** 被锁的运行 id。 */
  readonly runId: string;
}

/**
 * @beta
 * 工作流运行的**跨进程互斥锁**（`<workspace>/.omniharness/graph-runs/<runId>.lock`）。
 *
 * ## 为什么需要它（先有闸门，后有此锁）
 *
 * `GraphRunRegistry` 只在 **serve 进程内**挡住「同一 runId 被重复续跑」；而续跑入口有三个
 * （模型工具 / CLI `--resume-run` / serve RPC），其中 CLI 可以**同时开两个进程**对同一 runId 续跑。
 * 两个 runner 并发追加同一份 JSONL 的后果不是「跑两遍」这么轻：行会交错，
 * 而 `WorkflowRunLog.read()` 折叠的是**行序语义**（新 `step.start` 作废旧终态、`run.end` 收尾）——
 * 交错后折叠出来的既有状态是错的，且**看不出来错**。故续跑必须在文件层互斥。
 *
 * ## 三条设计纪律
 *
 * 1. **拿不到就拒绝，不排队**（fail-closed）：排队会让「谁先跑」变得不确定，而调用方（人或模型）
 *    此刻最需要的是**立刻知道**「另一个进程正在跑」，而不是无声等上几十分钟。
 * 2. **持锁进程已死 ⇒ 立即接管**（否则崩溃一次就永久锁死，而「崩溃后接着跑」正是本功能的初衷）：
 *    同主机按 PID 判活（`process.kill(pid, 0)`；`EPERM` 视为存活），跨主机退化为年龄判定。
 * 3. **只删自己的锁**：释放前核对锁里的 pid，避免把「已接管者的锁」误删。
 */
export class WorkflowRunLock {
  /**
   * @param workspaceRoot 工作区根（锁文件所在目录相对它解析）。
   */
  public constructor(private readonly workspaceRoot: string) {}

  /**
   * 锁文件路径（**不校验存在性**）。
   *
   * @param runId 运行 id（须为 `[A-Za-z0-9_-]{1,80}`，非法即抛）。
   * @returns 绝对路径。
   * @throws WorkflowSpecError runId 含路径穿越或非法字符时抛出。
   */
  public pathOf(runId: string): string {
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(runId)) {
      throw new WorkflowSpecError(
        `runId 非法（只允许 [A-Za-z0-9_-] 且长度 ≤80）：${JSON.stringify(runId)}`,
      );
    }
    return join(this.workspaceRoot, RUN_DIR, `${runId}.lock`);
  }

  /**
   * 加锁（失败即抛，不等待）。
   *
   * @param runId 运行 id。
   * @returns 本次持有的锁信息。
   * @throws WorkflowSpecError 另一**存活**进程正持有该运行时抛出（含持锁 pid/host/时刻，便于排查）。
   */
  public acquire(runId: string): WorkflowRunLockInfo {
    const info: WorkflowRunLockInfo = {
      pid: process.pid,
      host: hostname(),
      at: new Date().toISOString(),
      runId,
    };
    if (this.tryCreate(runId, info)) {
      return info;
    }
    // 已被占用：先判是不是「死者的锁」。
    const holder = this.readHolder(runId);
    if (holder !== undefined && this.isStale(holder)) {
      this.remove(runId);
      if (this.tryCreate(runId, info)) {
        return info;
      }
    }
    throw new WorkflowSpecError(
      `该运行正被另一进程续跑（锁：pid=${holder?.pid ?? '未知'} host=${holder?.host ?? '未知'} at=${holder?.at ?? '未知'}）：` +
        `请等它结束，或确认它已死后再试（陈旧锁会在持锁进程消失或超过 ${STALE_LOCK_MS / 3600000} 小时后自动接管）`,
    );
  }

  /**
   * 释放锁（幂等；**只删自己的锁**）。
   *
   * @param runId 运行 id。
   * @returns 无返回值。
   */
  public release(runId: string): void {
    const holder = this.readHolder(runId);
    if (holder !== undefined && holder.pid !== process.pid) {
      return; // 已被他人接管：不越权删除。
    }
    this.remove(runId);
  }

  /**
   * 该运行当前是否被**存活**进程持有（只读探测，不加锁；供 CLI/工具在动手前给出人话提示）。
   *
   * @param runId 运行 id。
   * @returns 被存活进程持有为 true。
   */
  public isHeld(runId: string): boolean {
    const holder = this.readHolder(runId);
    return holder !== undefined && !this.isStale(holder);
  }

  /**
   * 独占创建锁文件（`wx` 语义：已存在即失败）。
   *
   * @param runId 运行 id。
   * @param info 锁信息。
   * @returns 创建成功为 true；已被占用为 false。
   */
  private tryCreate(runId: string, info: WorkflowRunLockInfo): boolean {
    const dir = join(this.workspaceRoot, RUN_DIR);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    let fd: number | undefined;
    try {
      fd = openSync(this.pathOf(runId), 'wx');
      writeSync(fd, `${JSON.stringify(info)}\n`);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        return false;
      }
      throw error; // 磁盘/权限问题必须暴露，不能当成「被占用」静默吞掉。
    } finally {
      if (fd !== undefined) {
        closeSync(fd);
      }
    }
  }

  /**
   * 读取当前锁信息（无锁或内容不可解析时返回 undefined）。
   *
   * @param runId 运行 id。
   * @returns 锁信息或 undefined。
   */
  private readHolder(runId: string): WorkflowRunLockInfo | undefined {
    const path = this.pathOf(runId);
    if (!existsSync(path)) {
      return undefined;
    }
    try {
      return JSON.parse(readFileSync(path, 'utf8')) as WorkflowRunLockInfo;
    } catch {
      // 半截写入（持锁进程在写锁文件时被杀）：内容不可解析 ⇒ 交由年龄判定接管，不在这里抛。
      return { pid: -1, host: 'unknown', at: new Date(0).toISOString(), runId };
    }
  }

  /**
   * 判定锁是否陈旧（持锁进程已死，或超过年龄上限）。
   *
   * @param holder 锁信息。
   * @returns 陈旧为 true。
   */
  private isStale(holder: WorkflowRunLockInfo): boolean {
    const path = this.pathOf(holder.runId);
    try {
      if (Date.now() - statSync(path).mtimeMs > STALE_LOCK_MS) {
        return true;
      }
    } catch {
      return true; // 文件已消失（竞态）：视为陈旧，让调用方重试创建。
    }
    // 只有同主机才能用 PID 判活：跨主机时 PID 无意义（可能是完全无关的进程）。
    if (holder.host !== hostname() || holder.pid <= 0) {
      return false;
    }
    return !WorkflowRunLock.isAlive(holder.pid);
  }

  /**
   * 删除锁文件（不存在时忽略）。
   *
   * @param runId 运行 id。
   * @returns 无返回值。
   */
  private remove(runId: string): void {
    try {
      unlinkSync(this.pathOf(runId));
    } catch {
      // 已不存在（或并发删除）：幂等，忽略。
    }
  }

  /**
   * 进程是否存活（同主机 PID 探测）。
   *
   * `EPERM` 表示「存在但无权限发信号」⇒ 视为存活；`ESRCH` ⇒ 已死。
   *
   * @param pid 进程 id。
   * @returns 存活为 true。
   */
  private static isAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'EPERM';
    }
  }
}
