/**
 * CancellationToken（Agent Loop V2，对标 codex CancellationToken 树思想，零依赖）。
 *
 * 为什么不用 AbortController：AbortSignal 只能单向 abort 且无 reason 传播树；
 * 这里补齐 ①子令牌级联取消（父取消→全部子取消）②结构化 reason ③throwIfAborted
 * 便捷断言 ④同步回调注册。语义对齐 Node 18+ AbortSignal 的消费者（signal 可直接
 * 透传给 fetch），同时保持零依赖。
 */

/** 取消原因分类（结构化，供 UI/日志/重试决策）。 */
export type CancelReason =
  | 'user' // 用户主动中断（Ctrl-C / 请求断开）
  | 'timeout' // wall-clock / 单步超时
  | 'loop-guard' // 失控检测熔断
  | 'shutdown' // 进程退出
  | 'parent' // 父令牌级联
  | { readonly custom: string };

/** 取消异常：throwIfAborted 抛出，catch 侧可精确识别「取消」与一般错误。 */
export class CancelledError extends Error {
  public readonly reason: CancelReason;
  public constructor(reason: CancelReason) {
    super(reason === 'user' ? '已取消（用户中断）' : `已取消: ${describeReason(reason)}`);
    this.name = 'CancelledError';
    this.reason = reason;
  }
}

function describeReason(reason: CancelReason): string {
  return typeof reason === 'string' ? reason : reason.custom;
}

/** 取消回调（注册后返回解绑函数）。 */
type AbortListener = (reason: CancelReason) => void;

export class CancellationToken {
  private aborted = false;
  private reason: CancelReason | undefined;
  private readonly listeners = new Set<AbortListener>();
  private readonly children = new Set<CancellationToken>();

  public constructor(private readonly parent?: CancellationToken) {
    if (parent !== undefined) {
      // 父令牌级联：父取消 → 子同步取消（reason 透传，标 parent 已足够精确）。
      parent.listen((reason) => this.cancel('parent'));
    }
  }

  /** 是否已取消。 */
  public get isCancelled(): boolean {
    return this.aborted;
  }

  /** 取消原因（未取消为 undefined）。 */
  public get cancelReason(): CancelReason | undefined {
    return this.reason;
  }

  /** 取消；重复调用幂等（首次 reason 生效）。 */
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

  /** 已取消则抛 CancelledError（await 间隙后调用，实现协作式取消）。 */
  public throwIfAborted(): void {
    if (this.aborted) {
      throw new CancelledError(this.reason ?? 'user');
    }
  }

  /** 注册取消回调，返回解绑函数。 */
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

  /** 派生子令牌：父取消 → 子取消；子取消不影响父。 */
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

  /** 竞速：promise 与取消竞速，先到者胜（取消即抛 CancelledError）。 */
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
