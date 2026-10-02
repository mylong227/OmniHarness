// **跨进程租约锁**：给「读—改—写」这类不能交错的小文件操作一个互斥区，并按商用做法处理
// 「持有者崩了」「锁被抢走」这两件必然会发生的事。
//
// ## 为什么不是「mkdir 一下就完事」（调研结论）
//
// 参考实现里的成熟做法是 **lockfile + mtime/租约 + 心跳 + 被抢占回调**（proper-lockfile 系列，
// 见 https://git.dei.uc.pt/pcaseiro/ES-team-zig/.../proper-lockfile/README.md ）：
// 单纯 `mkdir` 只在「拿到锁」这一半是对的，另外两半必须显式处理：
// 1. **持有者崩溃** ⇒ 锁必须能过期被接管，否则后续写入永久卡死（proper-lockfile 用 mtime + 周期性
//    update 心跳，过期即视为陈旧）；
// 2. **锁被别人抢走后自己还在写** ⇒ 必须能察觉并**放弃写入**，否则两个进程同时写同一份文件。
//    这正是「省掉 onCompromised ⇒ 被偷锁后从 fs 回调里抛错把进程打死」那个已知坑
//    （见 https://github.com/PrimeIntellect-ai/prime-agent/discussions/1556 ）。
//
// ## 本实现的口径（三条不变量）
//
// - **原子获取**：`mkdir` 失败即已被占用（Windows/POSIX 都保证原子）；
// - **接管也是原子的**：接管不直接删锁再建（那会让**两个**接管者同时成功），而是
//   `rename(lockDir → lockDir.stale.<pid>)`（原子，只有一个赢家）再 `mkdir`；
// - **fencing token**：每次获取把 `token` 自增并写进 `owner.json`；临界区里写盘前调 `guard()`
//   核对「磁盘上的 token 还是不是我的」——**不是就抛 `LockCompromisedError` 并放弃写入**
//   （宁可这次改动不落地，也不覆盖别人的写入）。
//
// 纯 fs、无第三方依赖；同步 API（调用方是同步的读—改—写）。可单测（见 tests/unit/fileLock.test.ts）。
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { hostname } from 'node:os';
import { LockCompromisedError } from './lockCompromisedError.js';

/** 自旋等待与租约参数。 */
export interface FileLockOptions {
  /** 单次等待切片（毫秒）。 */
  readonly sliceMs?: number;
  /** 最多等多久（毫秒）：到点就放弃（降级），不无限等。 */
  readonly waitMs?: number;
  /** 租约时长（毫秒）：超过它没被持有者刷新即视为陈旧、可接管。 */
  readonly leaseMs?: number;
}

/** 默认参数：切片 5ms、最多等 300ms、租约 5s。 */
const DEFAULT_SLICE_MS = 5;
const DEFAULT_WAIT_MS = 300;
const DEFAULT_LEASE_MS = 5_000;

/** 持锁者信息（写在 `<lock>.lock/owner.json`）。 */
interface LockOwner {
  /** fencing token：每次获取自增；写盘前用它核对锁是否仍属于自己。 */
  readonly token: number;
  /** 持有者 pid。 */
  readonly pid: number;
  /** 持有者主机名（跨机器共享存储时用于排障）。 */
  readonly host: string;
  /** 最近一次刷新时刻（毫秒）。 */
  readonly at: number;
}

/** 跨进程租约锁（原子获取 + 过期接管 + fencing token）。 */
export class FileLock {
  /** 锁目录路径。 */
  private readonly lockDir: string;
  /** 等待切片（毫秒）。 */
  private readonly sliceMs: number;
  /** 最长等待（毫秒）。 */
  private readonly waitMs: number;
  /** 租约时长（毫秒）。 */
  private readonly leaseMs: number;
  /** 本持有者的 token（未持有时为 0）。 */
  private token = 0;

  /**
   * @param targetPath 被保护的文件路径（锁目录取 `<targetPath>.lock`）
   * @param options 等待与租约参数
   */
  public constructor(targetPath: string, options: FileLockOptions = {}) {
    this.lockDir = `${targetPath}.lock`;
    this.sliceMs = options.sliceMs ?? DEFAULT_SLICE_MS;
    this.waitMs = options.waitMs ?? DEFAULT_WAIT_MS;
    this.leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
  }

  /**
   * 尝试获取租约（一次）。
   * @returns 拿到返回 true；被别人持有且租约未过期返回 false
   */
  public tryAcquire(): boolean {
    if (this.createLockDir()) return true;
    if (!this.isExpired()) return false;
    return this.takeOver();
  }

  /**
   * 释放锁（幂等；只删自己的锁目录）。
   * @returns 无返回值。
   */
  public release(): void {
    if (this.token !== 0 && this.currentToken() !== this.token) {
      // 锁已被别人接管：删掉就是删别人的锁，故只放弃本地 token。
      this.token = 0;
      return;
    }
    rmSync(this.lockDir, { recursive: true, force: true });
    this.token = 0;
  }

  /**
   * 在锁内执行：抢不到就在 `waitMs` 内有界自旋，仍抢不到返回 false（**由调用方降级，不抛错**）。
   *
   * 临界区拿到一个 `guard`：**写盘前必须调一次**，若锁已被接管会抛 {@link LockCompromisedError}
   * （调用方据此放弃写入，而不是覆盖别人的修改）。
   * @param fn 临界区函数（入参为 guard）
   * @returns 是否真正在锁内执行了 `fn`
   */
  public withLock(fn: (guard: () => void) => void): boolean {
    const deadline = Date.now() + this.waitMs;
    for (;;) {
      if (this.tryAcquire()) {
        try {
          fn(() => this.assertHeld());
          return true;
        } finally {
          this.release();
        }
      }
      if (Date.now() >= deadline) return false;
      FileLock.sleep(this.sliceMs);
    }
  }

  /**
   * 核对锁仍属于自己（fencing）。
   * @returns 无返回值。
   */
  public assertHeld(): void {
    const onDisk = this.currentToken();
    if (onDisk !== this.token || onDisk === 0) {
      throw new LockCompromisedError(
        `锁已被接管（期望 token ${this.token}，磁盘 token ${onDisk}）：放弃本次写入以免覆盖别人`,
      );
    }
  }

  /**
   * 原子创建锁目录并写入持有者信息。
   * @returns 创建成功返回 true
   */
  private createLockDir(): boolean {
    try {
      mkdirSync(this.lockDir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
      throw err;
    }
    this.token = this.currentToken() + 1;
    this.writeOwner();
    return true;
  }

  /**
   * 接管过期锁：`rename` 锁目录（原子，故**只有一个**接管者成功）后再 `mkdir` 建新锁。
   * @returns 接管成功返回 true
   */
  private takeOver(): boolean {
    const graveyard = `${this.lockDir}.stale.${process.pid}.${Date.now()}`;
    try {
      renameSync(this.lockDir, graveyard); // 只有一个接管者能成功
    } catch {
      return false; // 别人已经接管 / 锁刚被释放
    }
    const token = FileLock.readToken(graveyard) + 1;
    rmSync(graveyard, { recursive: true, force: true });
    try {
      mkdirSync(this.lockDir);
    } catch {
      return false;
    }
    this.token = token;
    this.writeOwner();
    return true;
  }

  /**
   * 租约是否已过期（读不到持有者信息时按「未过期」处理：保守，不抢活锁）。
   * @returns 过期返回 true
   */
  private isExpired(): boolean {
    const owner = this.readOwner();
    if (owner === undefined) {
      // 只有目录没有 owner.json（极窄的窗口：别人刚 mkdir 还没写）⇒ 用目录 mtime 兜底。
      try {
        return Date.now() - statSync(this.lockDir).mtimeMs > this.leaseMs;
      } catch {
        return false;
      }
    }
    return Date.now() - owner.at > this.leaseMs;
  }

  /**
   * 读磁盘上的 token（无锁 / 无持有者信息按 0）。
   * @returns token
   */
  private currentToken(): number {
    return FileLock.readToken(this.lockDir);
  }

  /**
   * 读某个锁目录的 token。
   * @param dir 锁目录
   * @returns token；缺失/损坏返回 0
   */
  private static readToken(dir: string): number {
    const owner = FileLock.readOwnerAt(dir);
    return owner === undefined ? 0 : owner.token;
  }

  /**
   * 读当前锁目录的持有者信息。
   * @returns 持有者信息；缺失/损坏返回 undefined
   */
  private readOwner(): LockOwner | undefined {
    return FileLock.readOwnerAt(this.lockDir);
  }

  /**
   * 读指定锁目录的持有者信息。
   * @param dir 锁目录
   * @returns 持有者信息；缺失/损坏返回 undefined
   */
  private static readOwnerAt(dir: string): LockOwner | undefined {
    const file = `${dir}/owner.json`;
    if (!existsSync(file)) return undefined;
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<LockOwner>;
      if (typeof parsed.token !== 'number' || typeof parsed.at !== 'number') return undefined;
      return {
        token: parsed.token,
        at: parsed.at,
        pid: typeof parsed.pid === 'number' ? parsed.pid : 0,
        host: typeof parsed.host === 'string' ? parsed.host : '',
      };
    } catch {
      return undefined;
    }
  }

  /**
   * 写持有者信息（含 fencing token、pid、主机名、刷新时刻）。
   * @returns 无返回值。
   */
  private writeOwner(): void {
    const owner: LockOwner = {
      token: this.token,
      pid: process.pid,
      host: hostname(),
      at: Date.now(),
    };
    try {
      writeFileSync(`${this.lockDir}/owner.json`, JSON.stringify(owner) + '\n', 'utf8');
    } catch {
      /* 排障信息写不进去不影响互斥语义（token 缺失时守卫会保守拒绝） */
    }
  }

  /**
   * 同步睡眠（Node 没有 `sleepSync`；`Atomics.wait` 是官方支持的阻塞式等待）。
   * @param ms 毫秒
   * @returns 无返回值。
   */
  private static sleep(ms: number): void {
    const buf = new Int32Array(new SharedArrayBuffer(4));
    Atomics.wait(buf, 0, 0, ms);
  }
}
