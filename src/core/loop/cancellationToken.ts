import { CancelledError, CancelReason } from './cancelledError.js';

/**
 * CancellationToken（Agent Loop V2，对标 codex CancellationToken 树思想，零依赖）。
 *
 * 为什么不用 AbortController：AbortSignal 只能单向 abort 且无 reason 传播树；
 * 这里补齐 ①子令牌级联取消（父取消→全部子取消）②结构化 reason ③throwIfAborted
 * 便捷断言 ④同步回调注册。语义对齐 Node 18+ AbortSignal 的消费者（signal 可直接
 * 透传给 fetch），同时保持零依赖。
 */

/** 取消回调（注册后返回解绑函数）。 */
type AbortListener = (reason: CancelReason) => void;

export class CancellationToken {
  /** 是否已取消（一次性翻转，不可逆）。 */
  private aborted = false;
  /** 取消原因（首次 cancel 的 reason 生效，重复调用幂等不覆盖）。 */
  private reason: CancelReason | undefined;
  /** 已注册的取消回调集合（取消后清空）。 */
  private readonly listeners = new Set<AbortListener>();
  /** 派生的子令牌集合（父取消时级联取消全部子令牌）。 */
  private readonly children = new Set<CancellationToken>();

  /**
   * @param parent 父令牌（可选）：父取消时本令牌级联取消（reason 标记为 'parent'）。
   */
  public constructor(private readonly parent?: CancellationToken) {
    if (parent !== undefined) {
      // 父令牌级联：父取消 → 子同步取消（reason 透传，标 parent 已足够精确）。
      parent.listen((reason) => this.cancel('parent'));
    }
  }

  /**
   * 是否已取消。
   * @returns 已取消为 true（一次性翻转后恒为 true）。
   */
  public get isCancelled(): boolean {
    return this.aborted;
  }

  /**
   * 取消原因（未取消为 undefined）。
   * @returns 首次 cancel 传入的结构化原因；未取消时为 undefined。
   */
  public get cancelReason(): CancelReason | undefined {
    return this.reason;
  }

  /**
   * 取消；重复调用幂等（首次 reason 生效）。
   * @param reason 结构化取消原因，随 CancelledError 抛出并级联给子令牌。
   
 * @returns 无返回值。
*/
  public cancel(reason: CancelReason = 'user'): void {
    if (this.aborted) {
      return;
    }
    this.aborted = true;
    this.reason = reason;
    for (const listener of [...this.listeners]) {
      try {
        listener(reason);
      } catch {
        // 回调异常绝不阻断取消传播
      }
    }
    for (const child of [...this.children]) {
      child.cancel(reason === 'parent' ? reason : 'parent');
    }
    this.listeners.clear();
    this.children.clear();
  }

  /** 已取消则抛 CancelledError（await 间隙后调用，实现协作式取消）。
   * @returns 无返回值。
   */
  public throwIfAborted(): void {
    if (this.aborted) {
      throw new CancelledError(this.reason ?? 'user');
    }
  }

  /**
   * 注册取消回调，返回解绑函数。
   * @param listener 取消时同步调用的回调（入参为取消原因）。
   * @returns 解绑函数；已取消时回调立即触发并返回 no-op 解绑。
   */
  public listen(listener: AbortListener): () => void {
    if (this.aborted) {
      listener(this.reason ?? 'user');
      return () => {};
    }
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * 派生子令牌：父取消 → 子取消；子取消不影响父。
   * @returns 新的子令牌（已被本令牌持有，父取消时级联取消）。
   */
  public child(): CancellationToken {
    const c = new CancellationToken();
    this.children.add(c);
    if (this.aborted) {
      c.cancel('parent');
    }
    return c;
  }

  /**
   * 兼容桥：转成标准 AbortSignal（供 fetch 等原生消费者直接使用）。
   * 零依赖实现——用 AbortController 做一次性桥接。
   * @returns 与本令牌取消状态联动的标准 AbortSignal（可直接透传 fetch）。
   */
  public toAbortSignal(): AbortSignal {
    const controller = new AbortController();
    if (this.aborted) {
      controller.abort();
      return controller.signal;
    }
    this.listen(() => controller.abort());
    return controller.signal;
  }

  /**
   * 竞速：promise 与取消竞速，先到者胜（取消即抛 CancelledError）。
   * @param promise 与取消信号竞速的原 promise。
   * @returns 先到者结果：promise 正常/异常原样透传；先取消则抛 CancelledError。
   */
  public race<T>(promise: Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const unbind = this.listen((reason) => reject(new CancelledError(reason)));
      promise.then(
        (value) => {
          unbind();
          resolve(value);
        },
        (err) => {
          unbind();
          reject(err);
        },
      );
    });
  }
}

export { CancelledError } from './cancelledError.js';
