import type { LiveSessionRewindPort } from '../ports/runtime/liveSessionRewindPort.js';
import { log } from '../util/logger.js';

/**
 * 在跑会话的事件流回卷登记表（进程级）。
 *
 * ## 为什么是进程级静态登记表（而不是组合根注入）
 *
 * 「本进程此刻在跑哪些会话」是**进程级资源事实**，与 `subagent/worktree.ts` 的
 * `worktreeLocks` 同类（已按「锁表语义即进程级资源，无跨实例需求」保留）。
 * 反过来，若按组合根注入，会出现两个真实缺陷：
 *  - 工具在**组合根构建期**注册（`ConfigToolRegistry` 造 `CheckpointManager`），会话在
 *    **运行期**创建（`Agent`）；注入要求装配期就知道运行期的登记表实例，等于把「进程事实」
 *    伪装成「装配参数」；
 *  - 同一进程里若存在多个运行时（主 Agent + 子代理运行时），注入版会让 A 的检查点回滚
 *    看不到 B 的在跑会话——而磁盘是**共享**的，回滚必须能触及真正在跑的那个会话。
 *
 * ## 契约（与 `Agent.runningSessions` 同款隔离纪律）
 *
 * `unregister` 只在**登记项身份一致**时删除：并发回合若复用同一 sessionId（不该发生，但防御），
 * 先结束的回合不得把后启动回合的登记删掉（那会让后来者的回滚静默失效）。
 *
 * 已登记于 `docs/archive/SINGLETON_REGISTRY.md`。
 */
export class LiveSessionRewindRegistry implements LiveSessionRewindPort {
  /** 进程级唯一登记表（懒构造）。 */
  private static shared: LiveSessionRewindRegistry | undefined;

  /**
   * 取进程级登记表。
   * @returns 本进程唯一的 `LiveSessionRewindRegistry`。
   */
  public static sharedRegistry(): LiveSessionRewindRegistry {
    LiveSessionRewindRegistry.shared ??= new LiveSessionRewindRegistry();
    return LiveSessionRewindRegistry.shared;
  }

  /**
   * 丢弃共享实例（**仅测试隔离用**：生产调用即丢掉全部在跑会话的回卷能力）。
   * @returns 无返回值。
   */
  public static reset(): void {
    LiveSessionRewindRegistry.shared = undefined;
  }

  /** sessionId → 回卷回调（回调由在跑会话自身提供，登记表不持有事件流）。 */
  private readonly sessions = new Map<string, (size: number) => Promise<void>>();

  /**
   * 登记一个在跑会话的回卷回调（会话启动时调用）。
   * @param sessionId 会话 ID。
   * @param rewinder 把该会话事件流截断到给定长度的回调。
   * @returns 无返回值。
   */
  public register(sessionId: string, rewinder: (size: number) => Promise<void>): void {
    this.sessions.set(sessionId, rewinder);
  }

  /**
   * 反注册（会话结束时调用）；仅当登记项仍是 `rewinder` 本身时才删除。
   * @param sessionId 会话 ID。
   * @param rewinder 登记时传入的同一函数引用。
   * @returns 无返回值。
   */
  public unregister(sessionId: string, rewinder: (size: number) => Promise<void>): void {
    if (this.sessions.get(sessionId) === rewinder) {
      this.sessions.delete(sessionId);
    }
  }

  /**
   * 已登记的在跑会话数（观测/测试用）。
   * @returns 登记表条目数。
   */
  public size(): number {
    return this.sessions.size;
  }

  /**
   * 回卷指定会话的事件流到 `size` 条。
   * @param sessionId 目标会话 ID。
   * @param size 截断后保留的事件条数。
   * @returns 是否命中在跑会话（未命中 = 磁盘回滚已足够，非失败）。
   */
  public async rewind(sessionId: string, size: number): Promise<boolean> {
    const rewinder = this.sessions.get(sessionId);
    if (rewinder === undefined) {
      return false;
    }
    try {
      await rewinder(size);
      return true;
    } catch (error) {
      // fail-soft 但**不静默**：内存回卷失败意味着磁盘与内存已分叉（下一步落盘可能把回滚覆盖），
      // 调用方必须能看见，而不是收到一句「回滚成功」。
      log.warn('session.rewind.failed', {
        sessionId,
        size,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }
}
