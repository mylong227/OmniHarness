/**
 * 进程内**键控读写锁**（多读者 / 单写者 / FIFO + 写者优先）。
 *
 * ## 为什么需要它（而不是只靠文件锁）
 *
 * `serve` 里多个会话共享同一个进程、同一个工作区。文件锁（`FileLock`）能挡住**另一个进程**，
 * 但同进程内的两个会话若都去抢 `mkdir` 锁，会退化成磁盘轮询：每次争抢都要建目录、写 owner、
 * 读 token。本锁把「同一进程内的互斥」放在内存里完成（O(1) 队列），文件锁只承担跨进程那一层。
 *
 * ## 语义（三条不变量）
 *
 * 1. **读读并行**：多个读者可同时持有同一 key；写者必须等所有读者退出。
 * 2. **写写互斥**：同一 key 同时最多一个写者。
 * 3. **写者优先 + FIFO**：队列里有写者时，后到的读者排到写者之后（否则源源不断的读会让写者饿死）。
 *    这与「读者优先」相反，但对文件写入是正确取舍：读很快、写很少，让写先过。
 *
 * 取消（AbortSignal）与超时都会把等待者从队列里摘掉，**不会**让已授予的锁泄漏。
 */
import { LockError } from './lockError.ts';

/** 释放函数（幂等：重复调用只生效一次）。 */
export type LockRelease = () => void;

/** 等待选项。 */
export interface LockWaitOptions {
  /** 取消信号：等待中被取消会拒绝 `LockError('aborted')`。 */
  readonly signal?: AbortSignal | undefined;
  /** 最长等待毫秒数；超时拒绝 `LockError('timeout')`。缺省不超时（由调用方保证有界）。 */
  readonly timeoutMs?: number | undefined;
}

/** 锁模式。 */
type LockMode = 'read' | 'write';

/** 等待者。 */
interface Waiter {
  readonly mode: LockMode;
  readonly resolve: (release: LockRelease) => void;
  readonly reject: (error: Error) => void;
  timer?: ReturnType<typeof setTimeout> | undefined;
  signal?: AbortSignal | undefined;
  onAbort?: (() => void) | undefined;
  settled: boolean;
}

/** 单 key 状态。 */
interface LockEntry {
  readers: number;
  writer: boolean;
  readonly queue: Waiter[];
}

/** 观测快照。 */
export interface ReadWriteLockStats {
  /** 当前有状态的 key 数。 */
  readonly keys: number;
  /** 正在持读锁的总数。 */
  readonly readers: number;
  /** 正在持写锁的总数（0/1 每 key，这里是跨 key 求和）。 */
  readonly writers: number;
  /** 排队等待者总数。 */
  readonly waiters: number;
  /** 历史峰值读者数。 */
  readonly peakReaders: number;
  /** 历史峰值写者数。 */
  readonly peakWriters: number;
}

/** 键控读写锁（无模块级可变状态，可多实例并发使用）。 */
export class KeyedReadWriteLock {
  /** key → 状态。 */
  private readonly entries = new Map<string, LockEntry>();
  /** 历史峰值读者。 */
  private peakReaders = 0;
  /** 历史峰值写者。 */
  private peakWriters = 0;

  /**
   * 获取读锁（多读者可同时持有）。
   * @param key 资源键（调用方负责归一化，例如绝对路径小写）。
   * @param options 取消/超时选项。
   * @returns 释放函数（幂等）。
   */
  public acquireRead(key: string, options: LockWaitOptions = {}): Promise<LockRelease> {
    return this.acquire(key, 'read', options);
  }

  /**
   * 获取写锁（与同 key 的所有读写互斥）。
   * @param key 资源键。
   * @param options 取消/超时选项。
   * @returns 释放函数（幂等）。
   */
  public acquireWrite(key: string, options: LockWaitOptions = {}): Promise<LockRelease> {
    return this.acquire(key, 'write', options);
  }

  /**
   * 观测快照（诊断用；不改变状态）。
   * @returns 当前计数与历史峰值。
   */
  public stats(): ReadWriteLockStats {
    let readers = 0;
    let writers = 0;
    let waiters = 0;
    for (const entry of this.entries.values()) {
      readers += entry.readers;
      writers += entry.writer ? 1 : 0;
      waiters += entry.queue.length;
    }
    return {
      keys: this.entries.size,
      readers,
      writers,
      waiters,
      peakReaders: this.peakReaders,
      peakWriters: this.peakWriters,
    };
  }

  /**
   * 获取锁的统一入口。
   * @param key 资源键。
   * @param mode 读/写。
   * @param options 取消/超时选项。
   * @returns 释放函数。
   */
  private acquire(key: string, mode: LockMode, options: LockWaitOptions): Promise<LockRelease> {
    const entry = this.entryOf(key);
    // 快路径：无人排队时才允许立即授予，保证 FIFO（后来的读不能插到排队的写前面）。
    if (entry.queue.length === 0 && this.canGrant(entry, mode)) {
      this.grant(entry, mode);
      return Promise.resolve(this.releaseOf(key, entry, mode));
    }
    if (options.signal?.aborted === true) {
      this.cleanup(key, entry);
      return Promise.reject(new LockError('aborted', `等待 ${mode} 锁已取消: ${key}`));
    }
    return new Promise<LockRelease>((resolve, reject) => {
      const waiter: Waiter = {
        mode,
        resolve: (release) => {
          waiter.settled = true;
          this.clearWaiter(waiter);
          resolve(release);
        },
        reject: (error) => {
          waiter.settled = true;
          this.clearWaiter(waiter);
          reject(error);
        },
        settled: false,
      };
      if (options.timeoutMs !== undefined && options.timeoutMs >= 0) {
        waiter.timer = setTimeout(() => {
          if (waiter.settled) return;
          const removed = this.remove(entry, waiter);
          waiter.settled = true;
          this.clearWaiter(waiter);
          if (removed) {
            waiter.reject(
              new LockError(
                'timeout',
                `等待 ${mode} 锁超时（${String(options.timeoutMs)}ms）: ${key}`,
              ),
            );
            this.cleanup(key, entry);
          }
        }, options.timeoutMs);
      }
      if (options.signal !== undefined) {
        waiter.signal = options.signal;
        waiter.onAbort = () => {
          if (waiter.settled) return;
          const removed = this.remove(entry, waiter);
          waiter.settled = true;
          this.clearWaiter(waiter);
          if (removed) {
            waiter.reject(new LockError('aborted', `等待 ${mode} 锁已取消: ${key}`));
            this.cleanup(key, entry);
          }
        };
        options.signal.addEventListener('abort', waiter.onAbort, { once: true });
      }
      entry.queue.push(waiter);
    });
  }

  /**
   * 取或建 key 状态。
   * @param key 资源键。
   * @returns 状态对象。
   */
  private entryOf(key: string): LockEntry {
    const existing = this.entries.get(key);
    if (existing !== undefined) return existing;
    const entry: LockEntry = { readers: 0, writer: false, queue: [] };
    this.entries.set(key, entry);
    return entry;
  }

  /**
   * 当前状态能否立即授予某模式。
   * @param entry 状态。
   * @param mode 读/写。
   * @returns 可授予时为 true。
   */
  private canGrant(entry: LockEntry, mode: LockMode): boolean {
    if (entry.writer) return false;
    return mode === 'read' ? true : entry.readers === 0;
  }

  /**
   * 立即授予（调用方已确认 canGrant）。
   * @param entry 状态。
   * @param mode 读/写。
   * @returns 无返回值。
   */
  private grant(entry: LockEntry, mode: LockMode): void {
    if (mode === 'read') {
      entry.readers += 1;
      this.peakReaders = Math.max(this.peakReaders, entry.readers);
    } else {
      entry.writer = true;
      this.peakWriters = Math.max(this.peakWriters, 1);
    }
  }

  /**
   * 构造幂等释放函数。
   * @param key 资源键。
   * @param entry 状态。
   * @param mode 读/写。
   * @returns 释放函数。
   */
  private releaseOf(key: string, entry: LockEntry, mode: LockMode): LockRelease {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (mode === 'read') {
        entry.readers = Math.max(0, entry.readers - 1);
      } else {
        entry.writer = false;
      }
      this.pump(key, entry);
    };
  }

  /**
   * 释放后推进队列：先放行队首连续读者，无读者时再放行一个写者。
   * @param key 资源键。
   * @param entry 状态。
   * @returns 无返回值。
   */
  private pump(key: string, entry: LockEntry): void {
    if (entry.writer) return;
    while (entry.queue.length > 0) {
      const head = entry.queue[0];
      if (head === undefined || head.mode !== 'read') break;
      entry.queue.shift();
      if (head.settled) continue;
      this.grant(entry, 'read');
      head.resolve(this.releaseOf(key, entry, 'read'));
    }
    if (entry.readers === 0) {
      const head = entry.queue[0];
      if (head !== undefined && head.mode === 'write') {
        entry.queue.shift();
        if (!head.settled) {
          this.grant(entry, 'write');
          head.resolve(this.releaseOf(key, entry, 'write'));
        }
      }
    }
    this.cleanup(key, entry);
  }

  /**
   * 从队列里摘掉一个等待者。
   * @param entry 状态。
   * @param waiter 等待者。
   * @returns 摘到返回 true。
   */
  private remove(entry: LockEntry, waiter: Waiter): boolean {
    const index = entry.queue.indexOf(waiter);
    if (index < 0) return false;
    entry.queue.splice(index, 1);
    return true;
  }

  /**
   * 清理等待者的定时器与取消监听（避免已兑现的等待者二次触发）。
   * @param waiter 等待者。
   * @returns 无返回值。
   */
  private clearWaiter(waiter: Waiter): void {
    if (waiter.timer !== undefined) {
      clearTimeout(waiter.timer);
      waiter.timer = undefined;
    }
    if (waiter.onAbort !== undefined) {
      waiter.signal?.removeEventListener('abort', waiter.onAbort);
      waiter.onAbort = undefined;
      waiter.signal = undefined;
    }
  }

  /**
   * 空闲且无等待者时删除 key（防止长跑进程的 Map 无界增长）。
   * @param key 资源键。
   * @param entry 状态。
   * @returns 无返回值。
   */
  private cleanup(key: string, entry: LockEntry): void {
    if (entry.readers === 0 && !entry.writer && entry.queue.length === 0) {
      this.entries.delete(key);
    }
  }
}
