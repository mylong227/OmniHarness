import { closeSync, mkdirSync, openSync, rmSync, statSync, writeSync } from 'node:fs';
import { join } from 'node:path';

/**
 * CI/本地通用的**跨进程资源池**（2026-10-23）。
 *
 * 背景：Vitest 的 `fileParallelism` 是全局开关——为了少数会 spawn Chrome / Python / Worker
 * 的重判据把整个 617 文件串行化，代价是测试墙钟翻倍；而让它们与普通判据并发，又会在 CI
 * 2–4 核 runner 上互相抢 CPU/端口，产生「单跑绿、并行红」的假红（看板 §1.1 已登记）。
 *
 * 本池用文件锁把**重判据**限制到 N 个并发槽（默认 1），普通判据仍全速并行：
 *  - 每个槽是 `.tmp/vitest-heavy-slots/slot-<i>.lock`，`open(..., 'wx')` 原子创建；
 *  - 拿不到就等下一个槽，超时抛错（不让测试静默跳过）；
 *  - afterAll 释放；崩溃留下的锁超过 {@link STALE_MS} 视为陈旧并清理；
 *  - `OMNI_HEAVY_SLOTS` 可调（CI 可设 2，本地默认 1）。
 */
export class HeavyResourcePool {
  /** 陈旧锁阈值：超过即视为上一个进程已崩溃。 */
  private static readonly STALE_MS = 5 * 60_000;

  /** 等待上限（毫秒）。 */
  private static readonly WAIT_TIMEOUT_MS = 120_000;

  /** 锁目录（相对仓库根；测试从仓库根运行）。 */
  private static readonly DIR = join(process.cwd(), '.tmp', 'vitest-heavy-slots');

  /**
   * 获取一个槽；返回释放函数。
   * @param label 诊断标签（写进锁文件，便于排障）。
   * @returns 释放函数（必须调用，通常在 afterAll）。
   */
  public static async acquire(label: string): Promise<() => void> {
    const slots = HeavyResourcePool.slotCount();
    mkdirSync(HeavyResourcePool.DIR, { recursive: true });
    const deadline = Date.now() + HeavyResourcePool.WAIT_TIMEOUT_MS;
    for (;;) {
      for (let i = 0; i < slots; i += 1) {
        const path = join(HeavyResourcePool.DIR, `slot-${String(i)}.lock`);
        HeavyResourcePool.clearIfStale(path);
        try {
          const fd = openSync(path, 'wx');
          writeSync(fd, JSON.stringify({ pid: process.pid, label, at: Date.now() }));
          closeSync(fd);
          let released = false;
          return () => {
            if (released) return;
            released = true;
            try {
              rmSync(path, { force: true });
            } catch {
              // 已删除/权限问题：不影响测试结论。
            }
          };
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        }
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `[heavy-pool] 等待资源槽超时（${String(slots)} 槽，${String(
            HeavyResourcePool.WAIT_TIMEOUT_MS,
          )}ms）：${label}`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 100 + Math.floor(Math.random() * 100)));
    }
  }

  /** 槽数（`OMNI_HEAVY_SLOTS`，非法/≤0 回落 1）。
   * @returns 并发槽数。
   */
  public static slotCount(): number {
    const raw = Number(process.env['OMNI_HEAVY_SLOTS']);
    return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : 1;
  }

  /** 清理超过 STALE_MS 的锁文件。
   * @param path 锁路径。
   * @returns 无返回值。
   */
  private static clearIfStale(path: string): void {
    try {
      const info = statSync(path);
      if (Date.now() - info.mtimeMs > HeavyResourcePool.STALE_MS) {
        // 只清理确实陈旧的锁；正在跑的锁不动。
        rmSync(path, { force: true });
      }
    } catch {
      // 不存在/刚被释放：交给 open('wx') 判定。
    }
  }
}
