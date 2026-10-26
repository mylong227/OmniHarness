/**
 * **会话公平的资源调度器**（Start-time Fair Queueing / SFQ 的有界实现）。
 *
 * ## 要解决的问题
 *
 * `serve` 允许 N 个会话同时跑。若资源闸门只是一个全局 FIFO 信号量，**一个会话可以一次性
 * 塞进上百个任务**，把队列占满，其他会话的第一个任务要等它全部跑完（队头阻塞 / 饥饿）。
 * 这不是「并发太高」，而是**分配不均**：吞吐没变，尾延迟被一个会话拉爆。
 *
 * ## 数学口径（为什么不是轮询/随机）
 *
 * 把每个任务看成一个包，会话 `i` 的第 `k` 个包带虚拟时间标签：
 *
 * - `start(i,k) = max(V, finish(i,k-1))`
 * - `finish(i,k) = start(i,k) + 1 / w_i`
 * - 每次调度选 **finish 最小**的包，然后 `V ← max(V, start)`（V 是系统虚拟时间）
 *
 * 这就是 start-time fair queueing。它保证（在理想流体近似下）任意时间窗内各会话获得的服务量
 * 按权重 `w_i` 成比例，且**新会话从当前 V 起算**，不会继承别人的历史欠账。实现上用
 * 「每会话 FIFO + 每次扫描所有会话头」——会话数远小于任务数，O(S) 扫描比堆更简单且确定。
 *
 * 与 `ConcurrencyLimiter` 的分工：后者是**总量**闸门（并发上限），本类决定**谁先上**；
 * 两者叠加 = 总量有界 + 分配公平。
 *
 * @maturity L2 — 真实实现 SFQ 的 start/finish 标签与最小标签选择；理想流体模型的偏差界未证明
 * @maturityEvidence tests/unit/fairSessionScheduler.test.ts
 */
import { LockError } from './lockError.ts';

/** 构造选项。 */
export interface FairSessionSchedulerOptions {
  /** 全局并发上限（≥1 的整数）。 */
  readonly limit: number;
  /** 会话权重（缺省 1；内部钳制到 [0.1, 10]，避免一个超大权重饿死其他会话）。 */
  readonly weightOf?: ((sessionId: string) => number) | undefined;
  /** 单会话最多排队多少个（缺省 64）；超出即拒绝（不无限占内存）。 */
  readonly maxQueuePerSession?: number | undefined;
  /** 全局最多排队多少个（缺省 256）。 */
  readonly maxQueueTotal?: number | undefined;
}

/** 观测快照。 */
export interface FairSchedulerStats {
  /** 并发上限。 */
  readonly limit: number;
  /** 正在执行的任务数。 */
  readonly active: number;
  /** 正在排队的任务数。 */
  readonly waiting: number;
  /** 历史峰值并发。 */
  readonly peakActive: number;
  /** 累计调度次数。 */
  readonly dispatched: number;
  /** 当前系统虚拟时间（单调递增）。 */
  readonly virtualTime: number;
  /** 当前仍有状态的会话数。 */
  readonly sessions: number;
}

/** 等待选项。 */
export interface FairRunOptions {
  /** 取消信号（排队中被取消即拒绝；已在执行时由任务自行观察同一信号）。 */
  readonly signal?: AbortSignal | undefined;
  /** 最长排队毫秒数（缺省不超时；执行时间不在此限内）。 */
  readonly timeoutMs?: number | undefined;
}

/** 排队中的任务。 */
interface ScheduledJob {
  readonly sessionId: string;
  readonly seq: number;
  readonly start: number;
  readonly finish: number;
  readonly task: () => Promise<unknown>;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  settled: boolean;
  signal?: AbortSignal | undefined;
  onAbort?: (() => void) | undefined;
  timer?: ReturnType<typeof setTimeout> | undefined;
}

/** 单会话状态。 */
interface SessionState {
  readonly id: string;
  readonly queue: ScheduledJob[];
  lastFinish: number;
  active: number;
}

/** 会话公平调度器（无模块级可变状态，可多实例使用）。 */
export class FairSessionScheduler {
  /** 进程内共享调度器（按资源名缓存；跨 Runtime 重建仍对同一批会话公平）。 */
  private static readonly sharedSchedulers = new Map<string, FairSessionScheduler>();

  /** 全局并发上限。 */
  private readonly limit: number;
  /** 单会话队列上限。 */
  private readonly maxQueuePerSession: number;
  /** 全局队列上限。 */
  private readonly maxQueueTotal: number;
  /** 会话权重函数。 */
  private readonly weightOf: (sessionId: string) => number;
  /** 会话状态表。 */
  private readonly sessions = new Map<string, SessionState>();
  /** 正在执行的任务数。 */
  private active = 0;
  /** 正在排队的任务数。 */
  private waiting = 0;
  /** 历史峰值并发。 */
  private peakActive = 0;
  /** 累计调度次数。 */
  private dispatched = 0;
  /** 系统虚拟时间。 */
  private virtualTime = 0;
  /** 全局任务序号（同标签时保证确定性）。 */
  private seq = 0;

  /**
   * @param options 并发上限、权重与队列上限（limit 非法即抛 RangeError，避免永不放行的闸门）。
   */
  public constructor(options: FairSessionSchedulerOptions) {
    if (!Number.isFinite(options.limit) || options.limit < 1) {
      throw new RangeError(`会话调度器并发上限非法: ${String(options.limit)}（需 ≥1）`);
    }
    this.limit = Math.floor(options.limit);
    this.maxQueuePerSession = Math.max(1, Math.floor(options.maxQueuePerSession ?? 64));
    this.maxQueueTotal = Math.max(1, Math.floor(options.maxQueueTotal ?? 256));
    this.weightOf = options.weightOf ?? (() => 1);
  }

  /**
   * 取进程内共享的调度器（同一资源名返回同一实例；第一次调用决定选项）。
   * @param key 资源名（例如 `shell:<workspaceRoot>`）。
   * @param options 构造选项（仅首次生效）。
   * @returns 共享调度器。
   */
  public static shared(key: string, options: FairSessionSchedulerOptions): FairSessionScheduler {
    const existing = FairSessionScheduler.sharedSchedulers.get(key);
    if (existing !== undefined) return existing;
    const created = new FairSessionScheduler(options);
    FairSessionScheduler.sharedSchedulers.set(key, created);
    return created;
  }

  /**
   * 忘掉共享调度器（测试隔离用；生产不需要）。
   * @param key 资源名；缺省清空全部。
   * @returns 无返回值。
   */
  public static forgetShared(key?: string): void {
    if (key === undefined) {
      FairSessionScheduler.sharedSchedulers.clear();
      return;
    }
    FairSessionScheduler.sharedSchedulers.delete(key);
  }

  /**
   * 以某个会话的身份排队执行任务。
   * @param sessionId 会话 id（空串归为 `(unknown)`，只影响归账不影响安全）。
   * @param task 任务体（其并发受全局上限约束）。
   * @param options 取消/排队超时。
   * @returns 任务结果或失败。
   */
  public run<T>(
    sessionId: string,
    task: () => Promise<T>,
    options: FairRunOptions = {},
  ): Promise<T> {
    const id = sessionId === '' ? '(unknown)' : sessionId;
    const session = this.sessionOf(id);
    if (session.queue.length >= this.maxQueuePerSession) {
      this.discardIdle(session);
      return Promise.reject(
        new LockError('queue-full', `会话 ${id} 的排队任务已达上限 ${this.maxQueuePerSession}`),
      );
    }
    if (this.waiting >= this.maxQueueTotal) {
      this.discardIdle(session);
      return Promise.reject(
        new LockError('queue-full', `全局排队任务已达上限 ${this.maxQueueTotal}`),
      );
    }
    if (options.signal?.aborted === true) {
      return Promise.reject(new LockError('aborted', '任务在排队前已被取消'));
    }
    const rawWeight = this.weightOf(id);
    const weight = Number.isFinite(rawWeight) ? Math.min(10, Math.max(0.1, rawWeight)) : 1;
    const start = Math.max(this.virtualTime, session.lastFinish);
    const finish = start + 1 / weight;
    session.lastFinish = finish;
    return new Promise<T>((resolve, reject) => {
      const job: ScheduledJob = {
        sessionId: id,
        seq: this.seq,
        start,
        finish,
        task: task as () => Promise<unknown>,
        resolve: (value) => resolve(value as T),
        reject,
        settled: false,
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
      };
      this.seq += 1;
      this.armWaiter(job, options);
      if (job.settled) return;
      session.queue.push(job);
      this.waiting += 1;
      this.pump();
    });
  }

  /**
   * 观测快照（诊断用）。
   * @returns 并发/排队/虚拟时间等计数。
   */
  public stats(): FairSchedulerStats {
    return {
      limit: this.limit,
      active: this.active,
      waiting: this.waiting,
      peakActive: this.peakActive,
      dispatched: this.dispatched,
      virtualTime: this.virtualTime,
      sessions: this.sessions.size,
    };
  }

  /**
   * 删除一个刚创建但未能入队的空闲会话（避免拒绝路径泄漏会话表）。
   * @param session 会话状态。
   * @returns 无返回值。
   */
  private discardIdle(session: SessionState): void {
    if (session.queue.length === 0 && session.active === 0) {
      this.sessions.delete(session.id);
    }
  }

  /**
   * 取或建会话状态。
   * @param id 会话 id。
   * @returns 会话状态。
   */
  private sessionOf(id: string): SessionState {
    const existing = this.sessions.get(id);
    if (existing !== undefined) return existing;
    const session: SessionState = { id, queue: [], lastFinish: 0, active: 0 };
    this.sessions.set(id, session);
    return session;
  }

  /**
   * 给排队任务装上取消/超时（在入队前调用）。
   * @param job 任务。
   * @param options 取消/超时。
   * @returns 无返回值。
   */
  private armWaiter(job: ScheduledJob, options: FairRunOptions): void {
    if (options.timeoutMs !== undefined && options.timeoutMs >= 0) {
      job.timer = setTimeout(() => {
        if (job.settled) return;
        this.cancelWaiting(
          job,
          new LockError('timeout', `排队超时（${String(options.timeoutMs)}ms）`),
        );
      }, options.timeoutMs);
    }
    if (options.signal !== undefined) {
      job.onAbort = () => this.cancelWaiting(job, new LockError('aborted', '任务在排队中被取消'));
      options.signal.addEventListener('abort', job.onAbort, { once: true });
    }
  }

  /**
   * 取消一个**尚未执行**的任务：从会话队列摘掉并拒绝。
   * @param job 任务。
   * @param error 拒绝原因。
   * @returns 无返回值。
   */
  private cancelWaiting(job: ScheduledJob, error: Error): void {
    if (job.settled) return;
    const session = this.sessions.get(job.sessionId);
    if (session !== undefined) {
      const index = session.queue.indexOf(job);
      if (index >= 0) session.queue.splice(index, 1);
      if (session.queue.length === 0 && session.active === 0) {
        this.sessions.delete(job.sessionId);
      }
    }
    job.settled = true;
    this.clearWaiter(job);
    this.waiting = Math.max(0, this.waiting - 1);
    job.reject(error);
    this.pump();
  }

  /**
   * 推进调度：在全局并发上限内反复挑选虚拟完成时间最小的队头。
   * @returns 无返回值。
   */
  private pump(): void {
    while (this.active < this.limit) {
      const session = this.nextSession();
      if (session === undefined) break;
      const job = session.queue.shift();
      if (job === undefined) continue;
      if (job.settled) continue;
      this.dispatch(job, session);
    }
  }

  /**
   * 选出当前应执行的会话（队头 finish 最小；并列按入队序号）。
   * @returns 会话状态；无任务时 undefined。
   */
  private nextSession(): SessionState | undefined {
    let best: SessionState | undefined;
    let bestHead: ScheduledJob | undefined;
    for (const session of [...this.sessions.values()]) {
      const head = this.headOf(session);
      if (head === undefined) {
        if (session.active === 0) this.sessions.delete(session.id);
        continue;
      }
      if (
        bestHead === undefined ||
        head.finish < bestHead.finish ||
        (head.finish === bestHead.finish && head.seq < bestHead.seq)
      ) {
        best = session;
        bestHead = head;
      }
    }
    return best;
  }

  /**
   * 取会话队头（跳过已取消但未及移除的条目）。
   * @param session 会话状态。
   * @returns 队头任务；无任务时 undefined。
   */
  private headOf(session: SessionState): ScheduledJob | undefined {
    while (session.queue.length > 0) {
      const head = session.queue[0];
      if (head === undefined) return undefined;
      if (!head.settled) return head;
      session.queue.shift();
    }
    return undefined;
  }

  /**
   * 真正启动任务：先记状态，再在微任务里跑任务体，完成后释放槽位并继续推进。
   * @param job 任务。
   * @param session 所属会话。
   * @returns 无返回值。
   */
  private dispatch(job: ScheduledJob, session: SessionState): void {
    this.active += 1;
    this.waiting = Math.max(0, this.waiting - 1);
    this.peakActive = Math.max(this.peakActive, this.active);
    this.dispatched += 1;
    session.active += 1;
    this.virtualTime = Math.max(this.virtualTime, job.start);
    this.clearWaiter(job);
    void Promise.resolve()
      .then(() => job.task())
      .then(
        (value) => job.resolve(value),
        (error: unknown) => job.reject(error instanceof Error ? error : new Error(String(error))),
      )
      .finally(() => {
        job.settled = true;
        this.active = Math.max(0, this.active - 1);
        session.active = Math.max(0, session.active - 1);
        this.virtualTime = Math.max(this.virtualTime, job.finish);
        if (session.queue.length === 0 && session.active === 0) {
          this.sessions.delete(session.id);
        }
        this.pump();
      });
  }

  /**
   * 清掉任务的定时器与取消监听。
   * @param job 任务。
   * @returns 无返回值。
   */
  private clearWaiter(job: ScheduledJob): void {
    if (job.timer !== undefined) {
      clearTimeout(job.timer);
      job.timer = undefined;
    }
    if (job.onAbort !== undefined) {
      job.signal?.removeEventListener('abort', job.onAbort);
      job.onAbort = undefined;
      job.signal = undefined;
    }
  }
}
