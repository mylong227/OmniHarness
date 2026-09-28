// **跨进程**文件锁：给「读—改—写」这类不能交错的小文件操作一个互斥区。
//
// ## 为什么需要它（2026-09-27 用户要求收掉「有界重试会放弃最后一次写入」这条边界）
//
// 侧车写入原先只有 `rev` 乐观并发：读到的 rev 变了就重读重算，最多 8 轮。这在正常情况下足够（并发写
// 会收敛），但**极端并发**（两个进程在同一毫秒级窗口里反复互相打断）会让最后一次写入**放弃**——
// 不损坏、不半截，可是用户那次改名/归档/排序没落地。
//
// 加一层 `mkdir` 互斥（`mkdir` 在 Windows 与 POSIX 上都是**原子创建、已存在则失败**，且不依赖任何
// 第三方库）：拿不到锁就有界自旋等一会儿，仍拿不到才退回乐观并发路径。
//
// ## 语义与故障口径
//
// - 锁 = 一个目录（`<file>.lock`）；持锁信息记在目录内的 `owner.json`（pid + 时间），便于排障；
// - **陈旧锁可被抢占**：持有者崩了不会永久卡死后续写入。判据是「锁目录的 mtime 早于 `staleMs`」，
//   抢占时只删目录（不删别人正在写的目标文件）；
// - 拿不到锁**不抛错**：`withLock` 返回 false，调用方自行决定降级（本仓降级为 rev 重试）；
// - 释放走 `finally`：函数抛错也释放（否则一次异常会把侧车写入永久锁死）。
//
// 纯 fs、无依赖，可单测（见 tests/unit/fileLock.test.ts）。
import { mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';

/** 自旋等待的默认参数。 */
export interface FileLockOptions {
  /** 单次等待切片（毫秒）。 */
  readonly sliceMs?: number;
  /** 最多等多久（毫秒）：到点就放弃（降级），不无限等。 */
  readonly waitMs?: number;
  /** 超过多久视为陈旧锁、可抢占（毫秒）。 */
  readonly staleMs?: number;
}

/** 默认参数：切片 5ms、最多等 300ms、锁超过 5s 视为陈旧。 */
const DEFAULT_SLICE_MS = 5;
const DEFAULT_WAIT_MS = 300;
const DEFAULT_STALE_MS = 5_000;

/** 跨进程文件锁（`mkdir` 互斥 + 陈旧抢占）。 */
export class FileLock {
  /** 锁目录路径。 */
  private readonly lockDir: string;
  /** 等待切片（毫秒）。 */
  private readonly sliceMs: number;
  /** 最长等待（毫秒）。 */
  private readonly waitMs: number;
  /** 陈旧阈值（毫秒）。 */
  private readonly staleMs: number;

  /**
   * @param targetPath 被保护的文件路径（锁目录取 `<targetPath>.lock`）
   * @param options 等待与陈旧参数
   */
  public constructor(targetPath: string, options: FileLockOptions = {}) {
    this.lockDir = `${targetPath}.lock`;
    this.sliceMs = options.sliceMs ?? DEFAULT_SLICE_MS;
    this.waitMs = options.waitMs ?? DEFAULT_WAIT_MS;
    this.staleMs = options.staleMs ?? DEFAULT_STALE_MS;
  }

  /**
   * 尝试抢锁（一次）。
   * @returns 抢到返回 true；被别人持有且未陈旧返回 false
   */
  public tryAcquire(): boolean {
    try {
      mkdirSync(this.lockDir);
      this.writeOwner();
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
    if (this.isStale()) {
      // 陈旧（持有者已崩）：清掉再抢一次。只删锁目录，不碰被保护文件。
      rmSync(this.lockDir, { recursive: true, force: true });
      try {
        mkdirSync(this.lockDir);
        this.writeOwner();
        return true;
      } catch {
        return false;
      }
    }
    return false;
  }

  /**
   * 释放锁（幂等）。
   * @returns 无返回值。
   */
  public release(): void {
    rmSync(this.lockDir, { recursive: true, force: true });
  }

  /**
   * 在锁内执行：抢不到就在 `waitMs` 内有界自旋，仍抢不到返回 false（**由调用方降级，不抛错**）。
   * @param fn 临界区函数
   * @returns 是否真正在锁内执行了 `fn`
   */
  public withLock(fn: () => void): boolean {
    const deadline = Date.now() + this.waitMs;
    for (;;) {
      if (this.tryAcquire()) {
        try {
          fn();
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
   * 同步睡眠（Node 没有 `sleepSync`；`Atomics.wait` 是官方支持的阻塞式等待）。
   * @param ms 毫秒
   * @returns 无返回值。
   */
  private static sleep(ms: number): void {
    const buf = new Int32Array(new SharedArrayBuffer(4));
    Atomics.wait(buf, 0, 0, ms);
  }

  /**
   * 锁是否陈旧（被保护文件所在目录的锁目录 mtime 早于阈值）。
   * @returns 陈旧返回 true；无法读取时按「不陈旧」处理（保守：不抢别人的锁）
   */
  private isStale(): boolean {
    try {
      return Date.now() - statSync(this.lockDir).mtimeMs > this.staleMs;
    } catch {
      return false;
    }
  }

  /**
   * 写入持锁者信息（排障用；写失败不影响锁本身）。
   * @returns 无返回值。
   */
  private writeOwner(): void {
    try {
      writeFileSync(
        `${this.lockDir}/owner.json`,
        JSON.stringify({ pid: process.pid, at: Date.now() }) + '\n',
        'utf8',
      );
    } catch {
      /* 排障信息写不进去不影响互斥语义 */
    }
  }
}
