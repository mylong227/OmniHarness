/** 自动化调度器：按间隔把到期任务交给运行回调。 */
import type { Automation, AutomationStore } from './automationStore.ts';
import { log } from '../../util/logger.ts';

/** 自动化调度器。 */
export class AutomationScheduler {
  /** 定时器句柄。 */
  private timer: ReturnType<typeof setInterval> | null = null;
  /** 是否正在跑一轮（防重入）。 */
  private running = false;

  /**
   * @param store 任务存储
   * @param run 触发回调（通常 createThread）
   * @param tickMs 检查间隔（毫秒）
   */
  public constructor(
    private readonly store: AutomationStore,
    private readonly run: (automation: Automation) => Promise<void>,
    private readonly tickMs = 30_000,
  ) {}

  /**
   * 启动定时检查（unref，不阻止进程退出）。
   * @returns 无返回值
   */
  public start(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => void this.tick(), this.tickMs);
    this.timer.unref?.();
  }

  /**
   * 停止调度。
   * @returns 无返回值
   */
  public stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * 立即检查一次到期任务；同一时刻只跑一轮，避免重叠。
   * @returns 无返回值
   */
  public async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (const automation of this.store.due()) {
        // 先落 lastRunAt：即使回调失败/进程崩溃，也不会在同一时间窗内反复触发。
        this.store.markRun(automation.id);
        try {
          await this.run(automation);
        } catch (error) {
          // 单条失败不影响其余任务——但**必须可观测**（2026-10-27 审计收口）：此前
          // 空吞错误且 lastRunAt 已落，用户定义的定时自动化会呈现「看起来在跑、
          // 实际每轮都失败」的假象且排障无门。
          log.warn('automation.tick.failed', {
            id: automation.id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    } finally {
      this.running = false;
    }
  }
}
