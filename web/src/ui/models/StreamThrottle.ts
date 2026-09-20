// 流式增量节流器：把高频 text_delta 合并成有界频率的刷新，同时保证最终文本逐字节一致。
//
// 为什么需要：`thread.text_delta` 每来一条就 setState 一次，长回答（数千条增量）会
// 逐条触发整棵中栏重渲染 ⇒ 掉帧。这里把增量先缓冲，至多每 intervalMs 刷新一次。
//
// 三条不变量：
//   1) 有界频率：任意时刻至多有一个在飞定时器，相邻两次 emit 间隔 >= intervalMs（首个增量立即出，首字不延迟）；
//   2) 零丢失：累计 emit 的文本拼接恒等于 push 过的全部增量拼接（收尾 flush 兜底）；
//   3) 可注入 / 可释放：时间源经 ThrottleClock 注入（测试用确定性假时钟），dispose() 取消在飞定时器。
//
// 纯逻辑、零 React、零 DOM，可直接在 node 环境单测（见 web/test/longSessionPerf.test.mjs）。

/**
 * 可注入时钟：把「读时间 + 排程 + 取消」三件事抽出来，
 * 使节流逻辑不直接裸调 setTimeout，测试可用确定性假时钟驱动。
 */
export interface ThrottleClock {
  /**
   * 读取当前时间（毫秒，单调即可）。
   * @returns 当前时间戳（毫秒）
   */
  now(): number;
  /**
   * 在 delayMs 毫秒后执行 cb。
   * @param cb 到期回调
   * @param delayMs 延迟毫秒数
   * @returns 可传给 cancel 的句柄
   */
  schedule(cb: () => void, delayMs: number): number;
  /**
   * 取消一个排程（已触发或已取消时为 no-op）。
   * @param handle schedule 返回的句柄
   * @returns 无
   */
  cancel(handle: number): void;
}

/** 节流器可选参数。 */
export interface StreamThrottleOptions {
  /** 两次刷新之间的最小间隔（毫秒），缺省 50ms。 */
  intervalMs?: number;
  /** 注入时钟，缺省用全局 setTimeout/clearTimeout/Date.now 包一层。 */
  clock?: ThrottleClock;
}

/** 默认刷新间隔（毫秒）。 */
const DEFAULT_INTERVAL_MS = 50;

/** 生产用时钟：唯一一处 setTimeout 调用，集中在此以便整体替换。 */
const REAL_CLOCK: ThrottleClock = {
  now: (): number => Date.now(),
  schedule: (cb: () => void, delayMs: number): number =>
    setTimeout(cb, delayMs) as unknown as number,
  cancel: (handle: number): void => clearTimeout(handle),
};

/** 流式增量节流器（一个回合一个实例，回合结束 flush 后 dispose）。 */
export class StreamThrottle {
  /** 两次刷新之间的最小间隔（毫秒）。 */
  private readonly intervalMs: number;
  /** 注入的时间源。 */
  private readonly clock: ThrottleClock;
  /** 刷新回调：收到「自上次刷新以来累计的增量拼接」。 */
  private readonly onEmit: (text: string) => void;
  /** 尚未刷出的增量缓冲。 */
  private buffer: string = '';
  /** 上次刷新的时刻（毫秒）。 */
  private lastEmitAt: number;
  /** 在飞定时器句柄（无排程时为 null）。 */
  private handle: number | null = null;
  /** 是否已释放：释放后 push/flush 一律 no-op，防止迟到增量复活 UI。 */
  private disposed: boolean = false;

  /**
   * @param onEmit 刷新回调（收到累计增量文本）
   * @param opts 可选参数（刷新间隔 / 注入时钟）
   */
  public constructor(onEmit: (text: string) => void, opts: StreamThrottleOptions = {}) {
    const ms = Math.floor(opts.intervalMs ?? DEFAULT_INTERVAL_MS);
    this.intervalMs = ms > 0 ? ms : DEFAULT_INTERVAL_MS;
    this.clock = opts.clock ?? REAL_CLOCK;
    this.onEmit = onEmit;
    // 回拨一个间隔：首个增量立即刷新（首字延迟优先于节流），此后受间隔约束。
    this.lastEmitAt = this.clock.now() - this.intervalMs;
  }

  /**
   * 追加一段增量：距上次刷新已满一个间隔则立即刷新，否则排程到间隔边界（至多一个在飞定时器）。
   * @param delta 增量文本（空串直接忽略）
   * @returns 无
   */
  public push(delta: string): void {
    if (this.disposed || delta === '') return;
    this.buffer += delta;
    if (this.handle !== null) return;
    const elapsed = this.clock.now() - this.lastEmitAt;
    if (elapsed >= this.intervalMs) {
      this.emit();
      return;
    }
    this.handle = this.clock.schedule(() => this.timerFire(), this.intervalMs - elapsed);
  }

  /**
   * 立即刷出缓冲区并取消在飞排程（回合收尾 / 组件卸载前调用，保证最终文本不丢字节）。
   * @returns 无
   */
  public flush(): void {
    if (this.disposed) return;
    this.cancelTimer();
    this.emit();
  }

  /**
   * 当前尚未刷出的增量文本（空串表示无待刷内容）。
   * @returns 待刷文本
   */
  public pending(): string {
    return this.buffer;
  }

  /**
   * 释放：取消在飞定时器并丢弃缓冲，此后 push/flush 均为 no-op。
   * @returns 无
   */
  public dispose(): void {
    this.cancelTimer();
    this.disposed = true;
    this.buffer = '';
  }

  /**
   * 定时器到期：清句柄后刷新一次。
   * @returns 无
   */
  private timerFire(): void {
    this.handle = null;
    this.emit();
  }

  /**
   * 把缓冲区交给回调；空缓冲不发（避免无意义刷新）。
   * @returns 无
   */
  private emit(): void {
    if (this.buffer === '') return;
    const text = this.buffer;
    this.buffer = '';
    this.lastEmitAt = this.clock.now();
    this.onEmit(text);
  }

  /**
   * 取消在飞定时器（无则 no-op）。
   * @returns 无
   */
  private cancelTimer(): void {
    if (this.handle === null) return;
    this.clock.cancel(this.handle);
    this.handle = null;
  }
}
