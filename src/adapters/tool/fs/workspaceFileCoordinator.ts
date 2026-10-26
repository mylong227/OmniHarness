/**
 * 工作区**文件访问协调器**：把「多会话 / 多进程同时读写同一文件」收口到一处。
 *
 * ## 三层保护（缺一层都会留下真实可复现的丢写路径）
 *
 * 1. **进程内键控读写锁**（`KeyedReadWriteLock`）：同进程多个会话共享。读读并行、写写互斥、
 *    写者优先（不让源源不断的读饿死写）。
 * 2. **跨进程租约锁**（`AsyncFileLock` → `FileLock`）：两个 `serve` / CLI 进程指向同一工作区时，
 *    仍然只有一个写者；锁目录放在 `<workspace>/.omniharness/locks/`，**不污染用户工作区**。
 * 3. **版本基线**（`FileContentLedger`）：写前比对「该会话上次读到的内容」与磁盘现状；
 *    不一致即拒绝覆盖，并给出可行动文案。
 *
 * 另外两件事在同一层解决：
 * - **原子写**（`AtomicFileWriter`）：读者不会看到半截文件；
 * - **读单飞**（`readText` 的 in-flight 表）：两个会话同时读同一文件只真正读一次盘。
 *
 * ## 为什么读也要进锁
 *
 * 写者会等正在进行的读结束再改盘（配合原子 rename），读者拿到的内容与「写前/写后」二选一，
 * 不会出现「读到一半被别人替换」。跨进程读不拿文件锁——`rename` 已保证完整快照，拿锁只会
 * 让读互相拖慢。
 *
 * @maturity L1 — 结构同构（多读者/单写者 + 跨进程 fencing）；活性与互斥由判据覆盖，未形式化验证
 * @maturityEvidence tests/unit/workspaceFileCoordinator.test.ts
 */
import { mkdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { AsyncFileLock } from '../../../util/concurrency/asyncFileLock.ts';
import {
  KeyedReadWriteLock,
  type LockRelease,
} from '../../../util/concurrency/keyedReadWriteLock.ts';
import { LockError } from '../../../util/concurrency/lockError.ts';
import { FileErrorCode } from '../../../util/fileErrorCode.ts';
import { log } from '../../../util/logger.ts';
import { FileContentLedger } from './fileContentLedger.ts';
import { FileReadLeaseHandle, type FileReadLease } from './fileReadLeaseHandle.ts';
import { FileWriteLeaseHandle, type FileWriteLease } from './fileWriteLeaseHandle.ts';
import { WorkspaceFilePath } from './workspaceFilePath.ts';

export type { FileReadLease } from './fileReadLeaseHandle.ts';
export type { FileWriteLease } from './fileWriteLeaseHandle.ts';

/** 默认最大读入字节（64 MiB，与 `ReadFileTool` 口径一致）。 */
const DEFAULT_MAX_READ_BYTES = 64 * 1024 * 1024;

/** 默认进程内写锁等待（毫秒）。 */
const DEFAULT_WRITE_WAIT_MS = 10_000;

/** 默认进程内读锁等待（毫秒）。 */
const DEFAULT_READ_WAIT_MS = 10_000;

/** 默认跨进程锁等待（毫秒）：写通常 <100ms，2s 足够；超时即让调用方重试而非无限挂住。 */
const DEFAULT_PROCESS_WAIT_MS = 2_000;

/** 默认跨进程租约（毫秒）。 */
const DEFAULT_LEASE_MS = 30_000;

/** 观测快照。 */
export interface WorkspaceFileCoordinatorStats {
  /** 进程内锁计数。 */
  readonly locks: ReturnType<KeyedReadWriteLock['stats']>;
  /** 正在单飞的读请求数。 */
  readonly inflightReads: number;
  /** 累计写临界区数。 */
  readonly writes: number;
  /** 累计写等待次数（拿到锁之前发生过等待）。 */
  readonly waits: number;
}

/** 构造选项。 */
export interface WorkspaceFileCoordinatorOptions {
  /** 进程内写锁等待（毫秒）。 */
  readonly writeWaitMs?: number | undefined;
  /** 进程内读锁等待（毫秒）。 */
  readonly readWaitMs?: number | undefined;
  /** 跨进程锁等待（毫秒）。 */
  readonly processWaitMs?: number | undefined;
  /** 跨进程租约（毫秒）。 */
  readonly leaseMs?: number | undefined;
}

/** 生效的等待/租约参数（合并成一个字段，避免类成员膨胀）。 */
interface CoordinatorLimits {
  /** 进程内写锁等待（毫秒）。 */
  readonly writeWaitMs: number;
  /** 进程内读锁等待（毫秒）。 */
  readonly readWaitMs: number;
  /** 跨进程锁等待（毫秒）。 */
  readonly processWaitMs: number;
  /** 跨进程租约（毫秒）。 */
  readonly leaseMs: number;
}

/** 工作区文件访问协调器（每个工作区根一个实例，同进程内共享）。 */
export class WorkspaceFileCoordinator {
  /** 已建协调器（按归一化根缓存；跨 Runtime 重建仍共享锁与账本）。 */
  private static readonly coordinators = new Map<string, WorkspaceFileCoordinator>();

  /** 工作区根（绝对路径）。 */
  public readonly root: string;
  /** 该工作区共享的内容账本。 */
  public readonly ledger: FileContentLedger;

  /** 进程内键控读写锁。 */
  private readonly locks = new KeyedReadWriteLock();
  /** 单飞读表（绝对路径 → 在飞 Promise）。 */
  private readonly inflightReads = new Map<string, Promise<string>>();
  /** 跨进程锁目录（`.omniharness/locks`）。 */
  private readonly lockRoot: string;
  /** 锁目录是否已创建（Promise 缓存，避免并发 mkdir）。 */
  private lockRootReady?: Promise<void> | undefined;
  /** 生效的等待/租约参数。 */
  private readonly limits: CoordinatorLimits;
  /** 累计写次数。 */
  private writes = 0;
  /** 累计等待次数。 */
  private waits = 0;

  /**
   * @param root 工作区根（绝对路径）。
   * @param options 等待/租约参数。
   */
  private constructor(root: string, options: WorkspaceFileCoordinatorOptions) {
    this.root = root;
    this.ledger = new FileContentLedger();
    this.lockRoot = resolve(root, '.omniharness', 'locks');
    this.limits = {
      writeWaitMs: Math.max(1, options.writeWaitMs ?? DEFAULT_WRITE_WAIT_MS),
      readWaitMs: Math.max(1, options.readWaitMs ?? DEFAULT_READ_WAIT_MS),
      processWaitMs: Math.max(0, options.processWaitMs ?? DEFAULT_PROCESS_WAIT_MS),
      leaseMs: Math.max(1_000, options.leaseMs ?? DEFAULT_LEASE_MS),
    };
  }

  /**
   * 取工作区协调器（同一根返回同一实例；第一次调用决定选项）。
   * @param root 工作区根。
   * @param options 等待/租约参数（仅首次生效）。
   * @returns 协调器。
   */
  public static of(
    root: string,
    options: WorkspaceFileCoordinatorOptions = {},
  ): WorkspaceFileCoordinator {
    const absolute = resolve(root);
    const cacheKey = WorkspaceFilePath.keyOf(absolute);
    const existing = WorkspaceFileCoordinator.coordinators.get(cacheKey);
    if (existing !== undefined) return existing;
    const created = new WorkspaceFileCoordinator(absolute, options);
    WorkspaceFileCoordinator.coordinators.set(cacheKey, created);
    return created;
  }

  /**
   * 忘掉某个根的协调器（测试隔离用；生产不需要）。
   * @param root 工作区根；缺省清空全部。
   * @returns 无返回值。
   */
  public static forget(root?: string): void {
    if (root === undefined) {
      WorkspaceFileCoordinator.coordinators.clear();
      return;
    }
    WorkspaceFileCoordinator.coordinators.delete(WorkspaceFilePath.keyOf(resolve(root)));
  }

  /**
   * 读取完整文本（同一路径的并发读共享一次盘 IO；可被取消等待，但不会取消别人共享的读）。
   * @param absolutePath 绝对路径。
   * @param maxBytes 最大字节数（缺省 64 MiB）。
   * @param signal 可选取消信号。
   * @returns UTF-8 文本。
   */
  public async readText(
    absolutePath: string,
    maxBytes: number = DEFAULT_MAX_READ_BYTES,
    signal?: AbortSignal,
  ): Promise<string> {
    if (signal?.aborted === true) {
      throw new LockError('aborted', '读取在开始前已被取消');
    }
    const key = WorkspaceFilePath.keyOf(absolutePath);
    let shared = this.inflightReads.get(key);
    if (shared === undefined) {
      shared = this.loadText(absolutePath, maxBytes);
      this.inflightReads.set(key, shared);
      const clear = (): void => {
        if (this.inflightReads.get(key) === shared) this.inflightReads.delete(key);
      };
      void shared.then(clear, clear);
    }
    return this.awaitAbortable(shared, signal);
  }

  /**
   * 在读锁内执行（多个读可并行；写者会等它们结束）。
   * @param absolutePath 绝对路径。
   * @param task 读任务（经租约读文本）。
   * @param options 取消/等待选项。
   * @returns 任务结果。
   */
  public async withRead<T>(
    absolutePath: string,
    task: (lease: FileReadLease) => Promise<T>,
    options: {
      readonly signal?: AbortSignal | undefined;
      readonly timeoutMs?: number | undefined;
    } = {},
  ): Promise<T> {
    const absolute = resolve(absolutePath);
    const key = WorkspaceFilePath.keyOf(absolute);
    const release = await this.locks.acquireRead(key, {
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
      timeoutMs: options.timeoutMs ?? this.limits.readWaitMs,
    });
    try {
      return await task(
        new FileReadLeaseHandle(absolute, (path, maxBytes) => this.readText(path, maxBytes)),
      );
    } finally {
      release();
    }
  }

  /**
   * 在单文件写锁内执行（进程内互斥 + 跨进程租约 + 原子写租约）。
   * @param absolutePath 绝对路径。
   * @param task 写任务。
   * @param options 取消选项。
   * @returns 任务结果。
   */
  public async withWrite<T>(
    absolutePath: string,
    task: (lease: FileWriteLease) => Promise<T>,
    options: { readonly signal?: AbortSignal | undefined } = {},
  ): Promise<T> {
    const absolute = resolve(absolutePath);
    const key = WorkspaceFilePath.keyOf(absolute);
    const started = Date.now();
    const release = await this.locks.acquireWrite(key, {
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
      timeoutMs: this.limits.writeWaitMs,
    });
    if (Date.now() - started > 5) this.waits += 1;
    try {
      const lock = await this.acquireProcessLock(absolute, options.signal);
      try {
        this.writes += 1;
        return await task(new FileWriteLeaseHandle(absolute, lock));
      } finally {
        lock.release();
      }
    } finally {
      release();
    }
  }

  /**
   * 在**多文件**写锁内执行：按归一化路径排序后一次性持有，避免 A→B / B→A 的死锁。
   * @param absolutePaths 目标绝对路径列表。
   * @param task 写任务（按绝对路径取租约）。
   * @param options 取消选项。
   * @returns 任务结果。
   */
  public async withWriteMany<T>(
    absolutePaths: readonly string[],
    task: (leases: ReadonlyMap<string, FileWriteLease>) => Promise<T>,
    options: { readonly signal?: AbortSignal | undefined } = {},
  ): Promise<T> {
    const paths = WorkspaceFilePath.uniqueSorted(absolutePaths);
    const local = await this.acquireLocalLocks(paths, options.signal);
    const process: AsyncFileLock[] = [];
    try {
      await this.ensureLockRoot();
      for (const path of paths) {
        process.push(await this.acquireProcessLock(path, options.signal));
      }
      const leases = new Map<string, FileWriteLease>();
      for (const [index, path] of paths.entries()) {
        const lock = process[index];
        if (lock === undefined) continue;
        leases.set(path, new FileWriteLeaseHandle(path, lock));
      }
      this.writes += 1;
      return await task(leases);
    } finally {
      for (const lock of [...process].reverse()) lock.release();
      for (const release of [...local].reverse()) release();
    }
  }

  /**
   * 观测快照（诊断用）。
   * @returns 锁/读/写计数。
   */
  public stats(): WorkspaceFileCoordinatorStats {
    return {
      locks: this.locks.stats(),
      inflightReads: this.inflightReads.size,
      writes: this.writes,
      waits: this.waits,
    };
  }

  /**
   * 取错误码（保留在协调器上，供既有工具调用；实现委托 `FileErrorCode`）。
   * @param error 任意错误。
   * @returns `code` 字段；没有时 undefined。
   */
  public static codeOf(error: unknown): string | undefined {
    return FileErrorCode.of(error);
  }

  /**
   * 真正读盘（单飞表里的共享 Promise 体）。
   * @param absolutePath 绝对路径。
   * @param maxBytes 最大字节数。
   * @returns 文本。
   */
  private async loadText(absolutePath: string, maxBytes: number): Promise<string> {
    const buffer = await readFile(absolutePath);
    if (buffer.byteLength > maxBytes) {
      throw new LockError(
        'unavailable',
        `文件过大: ${WorkspaceFilePath.displayOf(this.root, absolutePath)} 共 ${String(buffer.byteLength)} 字节，` +
          `超过读取上限 ${String(maxBytes)} 字节`,
      );
    }
    return buffer.toString('utf8');
  }

  /**
   * 等待共享 Promise，但允许调用方取消**等待**（不取消底层共享读）。
   * @param promise 共享 Promise。
   * @param signal 取消信号。
   * @returns 结果；取消时拒绝。
   */
  private awaitAbortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
    if (signal === undefined) return promise;
    return new Promise<T>((resolvePromise, reject) => {
      const onAbort = (): void => {
        reject(new LockError('aborted', '等待读取时被取消'));
      };
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
      promise.then(
        (value) => {
          signal.removeEventListener('abort', onAbort);
          resolvePromise(value);
        },
        (error: unknown) => {
          signal.removeEventListener('abort', onAbort);
          reject(error);
        },
      );
    });
  }

  /**
   * 逐把获取进程内写锁（失败时释放已获取的）。
   * @param paths 已排序路径。
   * @param signal 取消信号。
   * @returns 释放函数列表。
   */
  private async acquireLocalLocks(
    paths: readonly string[],
    signal?: AbortSignal,
  ): Promise<LockRelease[]> {
    const releases: LockRelease[] = [];
    try {
      for (const path of paths) {
        releases.push(
          await this.locks.acquireWrite(WorkspaceFilePath.keyOf(path), {
            ...(signal !== undefined ? { signal } : {}),
            timeoutMs: this.limits.writeWaitMs,
          }),
        );
      }
      return releases;
    } catch (error) {
      for (const release of [...releases].reverse()) release();
      throw error;
    }
  }

  /**
   * 获取跨进程租约；拿不到时抛 `LockError('busy')` 并如实给出持有者。
   * @param absolutePath 绝对路径。
   * @param signal 取消信号。
   * @returns 已持有的异步锁。
   */
  private async acquireProcessLock(
    absolutePath: string,
    signal?: AbortSignal,
  ): Promise<AsyncFileLock> {
    await this.ensureLockRoot();
    const key = WorkspaceFilePath.keyOf(absolutePath);
    const target = resolve(this.lockRoot, WorkspaceFilePath.hashOf(key));
    const lock = new AsyncFileLock(target, {
      waitMs: this.limits.processWaitMs,
      leaseMs: this.limits.leaseMs,
      sliceMs: 3,
    });
    const acquired = await lock.acquire(signal).catch((error: unknown) => {
      throw new LockError('unavailable', `无法创建文件锁: ${String(error)}`);
    });
    if (!acquired) {
      const holder = lock.holder();
      const detail =
        holder === undefined
          ? '另一个会话/进程正在写入（持有者信息不可读）'
          : `持有者 pid=${String(holder.pid)} host=${holder.host} token=${String(holder.token)}`;
      log.warn('workspace.file.busy', {
        path: WorkspaceFilePath.displayOf(this.root, absolutePath),
        holderPid: holder?.pid,
        holderHost: holder?.host,
      });
      throw new LockError(
        'busy',
        `文件 ${WorkspaceFilePath.displayOf(this.root, absolutePath)} 正被${detail}` +
          `（已等待 ${String(this.limits.processWaitMs)}ms）。` +
          '本次未写入；请稍后重试（不要并行重发同一条写入）。',
      );
    }
    return lock;
  }

  /**
   * 确保锁目录存在（并发调用共享同一个 Promise）。
   * @returns 目录就绪。
   */
  private async ensureLockRoot(): Promise<void> {
    if (this.lockRootReady === undefined) {
      this.lockRootReady = mkdir(this.lockRoot, { recursive: true }).then(
        () => undefined,
        (error: unknown) => {
          this.lockRootReady = undefined;
          throw new LockError(
            'unavailable',
            `无法创建锁目录 ${this.lockRoot}（文件写入需要跨进程互斥）: ${String(error)}`,
          );
        },
      );
    }
    await this.lockRootReady;
  }
}
