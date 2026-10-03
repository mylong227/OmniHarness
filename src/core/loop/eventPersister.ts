/**
 * EventPersister（Agent Loop V2 增量持久化，对标 deepseek-harness
 * session-persistence 的 write-behind 批量落盘思想，无第三方依赖）。
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

import type { SessionEvent } from '../../ports/runtime/event.js';
import type { StoragePort } from '../../ports/memory/storage.js';
import { log } from '../../util/logger.js';

export interface EventPersisterOptions {
  /** write-behind 批量延迟（ms），默认 200。0 = 禁用定时器（仅显式 flush）。 */
  readonly batchDelayMs?: number;
}

export class EventPersister {
  /** write-behind 延迟（ms）；0 = 禁用定时器，仅显式 flush 落盘。 */
  private readonly delayMs: number;
  /** 已排队的落盘定时器句柄（一个窗口内至多一个，幂等）。 */
  private timer: ReturnType<typeof setTimeout> | undefined;
  /**
   * flush 串行队列尾：每个 flush 都排在上一次之后。
   *
   * 为什么不是「在飞就返回」：那样**会丢掉请求**——定时器触发时若上一次写还在飞，
   * 新的那次直接 return，且它的定时器已被清空 ⇒ 期间新增的事件要等**下一次** schedule 才可能落盘；
   * 而回合末 `await persister.flush()` 也会在在飞写完成前就返回，调用方以为已落盘。
   * 排队则同时满足两点：**不丢请求**，且 `flush()` 返回时**它的快照确已写入**。
   */
  private queue: Promise<void> = Promise.resolve();
  /** 终止标志：dispose 后不再接受 schedule/flush（但已排队的落盘会自然完成）。 */
  private disposed = false;
  /** 上次成功落盘的事件数（增量语义：事件数未变则跳过写入）。 */
  private lastSavedCount = 0;
  /**
   * 强制下次落盘标志（**回卷专用**）。
   *
   * 为什么不靠长度判脏：事件流回卷后条数可能恰好等于 `lastSavedCount`（回滚到上一次成功落盘的点）
   * ⇒ 纯长度判据会跳过这次必需的落盘，把回滚后的截断状态留在内存里、盘上仍是全量。
   */
  private forceWrite = false;

  public constructor(
    /** 存储端口：快照经其 save(sessionId, events) 全量落盘。 */
    private readonly storage: StoragePort,
    /** 目标会话 ID：落盘写入的 key。 */
    private readonly sessionId: string,
    /** 事件提供者：落盘时刻读取当前事件快照（避免 persister 持有 recorder 引用）。 */
    private readonly getEvents: () => readonly SessionEvent[],
    /** 可选配置：批量延迟等。 */
    options: EventPersisterOptions = {},
  ) {
    this.delayMs = options.batchDelayMs ?? 200;
  }

  /** 事件追加后调用：安排一次延迟落盘（幂等，一个窗口内只排一个定时器）。
   * @returns 无返回值。
   */
  public schedule(): void {
    if (this.disposed || this.delayMs <= 0 || this.timer !== undefined) {
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush();
    }, this.delayMs);
  }

  /** 显式落盘当前快照：排队执行，返回时该次快照已写入（失败的降级见 {@link saveSnapshot}）。
   * @returns 该次落盘尝试完成后的 Promise（不抛错：失败仅 warn）。
   */
  public async flush(): Promise<void> {
    if (this.disposed) {
      return;
    }
    const task = this.queue.then(() => this.saveSnapshot());
    // 队列尾始终是「已处理错误」的 Promise，避免一次 getEvents 抛错让后续 flush 全部连锁失败。
    this.queue = task.catch(() => undefined);
    await task;
  }

  /** 停止定时器并标记终止（回合结束时调用；**已排队**的落盘自然完成）。
   * @returns 无返回值。
   */
  public dispose(): void {
    this.disposed = true;
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  /**
   * 事件流回卷后的对齐（**检查点回滚必须经过这里**，否则回滚会被在飞写覆盖回去）。
   *
   * 两个动作，缺一不可：
   *
   * 1. **等在飞写落地**（`await this.queue`）：调用方（`CheckpointManager.rollback`）已经在磁盘上
   *    写好了截断后的事件，但队列里可能还有一次**更早排队**的落盘，它读取的是回卷**之前**的全量
   *    快照——不等它落地，回滚会被这一次写原样覆盖（2026-10-03 登记的 P1 缺陷的持久化侧）。
   * 2. **强制立即重写**（`forceWrite` + `flush()`）：等完之后磁盘上很可能是那次旧的全量写，必须由
   *    我们自己把截断后的快照写回去。**不能只标记脏等下一次 schedule**：下一次 schedule 依赖
   *    「还有新事件产生」，而回滚后可能整回合再无新事件 ⇒ 陈旧全量快照会一直留在盘上。
   *
   * 至于「长度判脏不够用」：回卷后的条数可能恰好等于 `lastSavedCount`（例如回滚到上一次成功落盘
   * 的点），按长度判会**跳过**这次必需的重写，故用独立的 `forceWrite` 标志（与缺陷 1 的判据同源）。
   * @param size 回卷后的事件条数（语义与 `AppendOnlyEventLog.rewindTo` 一致）。
   * @returns 该次对齐完成后的 Promise（不抛错：落盘失败仅 warn，与 flush 契约一致）。
   */
  public async rewindTo(size: number): Promise<void> {
    if (this.disposed) {
      return;
    }
    await this.queue;
    // 与内存对齐：长度相等时靠 forceWrite 判脏，故此处只需保持「上次落盘条数」语义一致。
    this.lastSavedCount = size;
    this.forceWrite = true;
    await this.flush();
  }

  /**
   * 落盘一次当前快照（增量语义：事件数未变则跳过）。
   *
   * 失败**降级为 warn**（fail-soft，与 agent.persist 的既有容错一致）：既不上抛打断回合，
   * 也不静默——`lastSavedCount` 不前进，故下一次 flush 会重试同一批（直到成功或回合结束）。
   * @returns 无返回值。
   */
  private async saveSnapshot(): Promise<void> {
    // getEvents 也纳入 try（2026-10-03 修）：JSDoc 承诺 flush 不抛错，而 getEvents 是注入闭包
    // （现实现 eventLog.all() 不会抛，但契约不应依赖这一点）——闭包抛错会让 flush reject，
    // 定时器路径 `void this.flush()` 进而成为未处理 Promise rejection。
    let events: readonly SessionEvent[];
    try {
      events = this.getEvents();
    } catch (err) {
      log.warn('session.persist.get_events.failed', {
        sessionId: this.sessionId,
        error: String(err),
      });
      return;
    }
    if (events.length === 0 || (events.length === this.lastSavedCount && !this.forceWrite)) {
      return;
    }
    await this.write(events);
  }

  /**
   * 写一次快照：**优先追加**（G7），失败或不可追加时回退全量 `save`。
   *
   * 追加的三条前置（缺一即走全量）：
   *  1. 后端实现了可选通道 `append`；
   *  2. 本回合**已有一次成功落盘**（`lastSavedCount > 0`）——否则后端没有可比对的前缀；
   *  3. 不是回卷重写（`forceWrite`）：回卷是**截断**语义（少写），追加只能表达"多写"，故必须全量覆盖。
   *
   * 失败回退的必要性：`append` 的契约是 fail-closed（前缀校验不符即抛）。抛错时盘上历史仍是
   * **上一次成功的完整快照**，全量 `save` 一定能把当前内存态写正确 ⇒ 追加路径的任何异常都不会
   * 让历史错乱或丢失，最坏只是白付一次全量写。
   * @param events 当前事件快照（完整列表）。
   * @returns 无返回值（失败仅 warn，与 flush 契约一致）。
   */
  private async write(events: readonly SessionEvent[]): Promise<void> {
    const append = this.storage.append;
    const canAppend =
      append !== undefined &&
      !this.forceWrite &&
      this.lastSavedCount > 0 &&
      events.length > this.lastSavedCount;
    if (canAppend) {
      try {
        await append.call(this.storage, this.sessionId, events, this.lastSavedCount);
        this.lastSavedCount = events.length;
        return;
      } catch (err) {
        // 追加失败 ⇒ 回退全量（fail-safe）。这里刻意用 debug 而非 warn：契约明确允许回退，
        // 「第一次没有可比对前缀」这类正常情形也会走到这里，记 warn 会制造噪声。
        log.debug('session.persist.append_fallback', {
          sessionId: this.sessionId,
          fromCount: this.lastSavedCount,
          error: String(err),
        });
      }
    }
    try {
      await this.storage.save(this.sessionId, events);
      this.lastSavedCount = events.length;
      this.forceWrite = false;
    } catch (err) {
      log.warn('session.persist.failed', { sessionId: this.sessionId, error: String(err) });
    }
  }
}
