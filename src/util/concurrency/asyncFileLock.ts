/**
 * `FileLock` 的**异步封装**：用 `await + setTimeout` 轮询，而不是同步 `Atomics.wait`。
 *
 * 为什么不能直接用 `FileLock.withLock`：它为了让同步调用方（侧车 JSON 的读—改—写）不改变签名，
 * 用 `Atomics.wait` 阻塞线程。工具层是异步的，一个会话在等别的进程写完时若阻塞事件循环，
 * **同进程里所有会话**都会一起卡住——这正好放大了要解决的「多会话互相抢占」。本类只做两件事：
 *
 * 1. 有界异步轮询（带**全抖动**：`sleep = slice * (0.5 + random)`，打散同时到达的争抢者）；
 * 2. 持锁期间按租约 1/3 周期续租，长临界区不会被别的进程当「持有者崩了」接管。
 */
import { FileLock, type FileLockOwner } from './fileLock.ts';

/** 异步文件锁（同一 target 的跨进程互斥）。 */
export class AsyncFileLock {
  /** 底层同步锁（原子获取/接管/fencing 都在它里面）。 */
  private readonly lock: FileLock;
  /** 心跳定时器（持锁期间存在）。 */
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  /** 本实例是否持有锁。 */
  private held = false;

  /**
   * @param targetPath 被保护的目标路径（或自定义锁目录键；见 `FileLockOptions.lockDir`）。
   * @param options 等待/租约/自定义锁目录。
   */
  public constructor(targetPath: string, options: ConstructorParameters<typeof FileLock>[1] = {}) {
    this.lock = new FileLock(targetPath, options);
  }

  /**
   * 在等待上限内异步抢锁；成功即启动续租心跳。
   * @param signal 可选取消信号。
   * @returns 拿到锁返回 true；超时/取消/被占用返回 false。
   */
  public async acquire(signal?: AbortSignal): Promise<boolean> {
    const deadline = Date.now() + this.lock.waitMsOf();
    const slice = Math.max(1, Math.min(25, Math.floor(this.lock.waitMsOf() / 20)));
    for (;;) {
      if (signal?.aborted === true) return false;
      if (this.lock.tryAcquire()) {
        this.held = true;
        this.startHeartbeat();
        return true;
      }
      if (Date.now() >= deadline) return false;
      await AsyncFileLock.sleep(slice * (0.5 + Math.random()));
    }
  }

  /**
   * 释放锁并停止心跳（幂等）。
   * @returns 无返回值。
   */
  public release(): void {
    this.stopHeartbeat();
    if (this.held) {
      this.held = false;
      this.lock.release();
    }
  }

  /**
   * 写盘前核对锁仍属于自己（fencing）。
   * @returns 无返回值。
   * @throws LockCompromisedError 锁已被接管时抛出（调用方应放弃本次写入）。
   */
  public guard(): void {
    this.lock.assertHeld();
  }

  /**
   * 当前持有者（用于「谁挡住了我」的可行动文案）。
   * @returns 持有者信息；读不到时为 undefined。
   */
  public holder(): FileLockOwner | undefined {
    return this.lock.holder();
  }

  /**
   * 启动续租心跳；`renew()` 返回 false（已被接管）时自动停止。
   * @returns 无返回值。
   */
  private startHeartbeat(): void {
    this.stopHeartbeat();
    const every = Math.max(50, Math.floor(this.lock.leaseMsOf() / 3));
    this.heartbeat = setInterval(() => {
      if (!this.lock.renew()) this.stopHeartbeat();
    }, every);
    // 不阻止进程退出（测试/CLI 收尾时定时器不应成为活跃句柄）。
    this.heartbeat.unref?.();
  }

  /**
   * 停止心跳（幂等）。
   * @returns 无返回值。
   */
  private stopHeartbeat(): void {
    if (this.heartbeat !== undefined) {
      clearInterval(this.heartbeat);
      this.heartbeat = undefined;
    }
  }

  /**
   * 异步睡眠。
   * @param ms 毫秒（可为小数）。
   * @returns 到点后 resolve。
   */
  private static sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
  }
}
