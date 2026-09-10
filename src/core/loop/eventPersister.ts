/**
 * EventPersister（Agent Loop V2 增量持久化，对标 deepseek-harness
 * session-persistence 的 write-behind 批量落盘思想，零依赖）。
 *
 * 旧缺陷：storage.save 只在整回合结束的 finally 里调一次——长回合中途崩溃，
 * 已产生的全部事件丢失（审计 P0-3）。
 *
 * 机制：
 *  - 构造时注入 getEvents 事件提供者（闭包读 recorder.allEvents()）。
 *  - schedule() 由 TurnRunner 每步调用：write-behind 定时器（默认 200ms）到期
 *    自动落盘当前快照（StoragePort 契约是 save(sessionId, events) 全量写，
 *    增量语义靠「只在新事件出现后写」实现，接口零改动）。
 *  - flush() 供回合末/关键节点显式落盘并清理定时器。
 *  - 落盘失败降级为 warn 日志（fail-soft），绝不阻断主流程、绝不掩盖原始异常
 *    （与 agent.ts persist 的既有容错语义一致）。
 *  - dispose() 停止定时器（回合结束时调用，防止定时器泄漏）。
 */

import type { SessionEvent } from '../../ports/event.js';
import type { StoragePort } from '../../ports/storage.js';
import { log } from '../../util/logger.js';

export interface EventPersisterOptions {
  /** write-behind 批量延迟（ms），默认 200。0 = 禁用定时器（仅显式 flush）。 */
  readonly batchDelayMs?: number;
}

export class EventPersister {
  private readonly delayMs: number;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private flushing = false;
  private disposed = false;
  private lastSavedCount = 0;

  public constructor(
    private readonly storage: StoragePort,
    private readonly sessionId: string,
    /** 事件提供者：落盘时刻读取当前事件快照（避免 persister 持有 recorder 引用）。 */
    private readonly getEvents: () => readonly SessionEvent[],
    options: EventPersisterOptions = {},
  ) {
    this.delayMs = options.batchDelayMs ?? 200;
  }

  /** 事件追加后调用：安排一次延迟落盘（幂等，一个窗口内只排一个定时器）。 */
  public schedule(): void {
    if (this.disposed || this.delayMs <= 0 || this.timer !== undefined) {
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush();
    }, this.delayMs);
  }

  /** 显式落盘当前快照。并发 flush 串行化，避免旧快照覆盖新快照。 */
  public async flush(): Promise<void> {
    if (this.disposed || this.flushing) {
      return;
    }
    const events = this.getEvents();
    if (events.length === 0 || events.length === this.lastSavedCount) {
      return;
    }
    this.flushing = true;
    try {
      await this.storage.save(this.sessionId, events);
      this.lastSavedCount = events.length;
    } catch (err) {
      log.warn('session.persist.failed', { sessionId: this.sessionId, error: String(err) });
    } finally {
      this.flushing = false;
    }
  }

  /** 停止定时器并标记终止（回合结束时调用；已排队的 flush 自然完成）。 */
  public dispose(): void {
    this.disposed = true;
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }
}
