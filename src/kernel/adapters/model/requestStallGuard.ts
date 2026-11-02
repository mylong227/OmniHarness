/**
 * 单次模型请求的「空闲超时」守卫（#33）。
 *
 * 存在理由：`OpenAiCompatibleModel` 此前用裸 `fetch` 且**默认无任何超时**，而 `RetryingModel`
 * **只对「抛出的」错误重试** —— 服务端接受连接后不回包时 `fetch` 永不 settle（既不 resolve
 * 也不 reject），重试永不触发，整条调用链**无限期挂死**（2026-09-18 实测：SWE-bench 批次在单实例
 * 上静默挂死 32 分钟、日志零新增、工作区零写入）。此前只在调用方自带 `request.signal` 时才受保护，
 * 其余调用方（agent 主循环 / SDK / 基准脚本）全部暴露于同类挂起。
 *
 * 语义是**空闲**（idle）而非**总时限**（total deadline）：计时自请求发出起算，每收到一次数据
 * （响应头 / SSE 事件块）即重置 —— 故「慢但有进展」的长响应不会被误杀，只有「连续静默超过阈值」
 * 才中止。这正是此前不敢给适配器加默认超时的顾虑所在：总时限会硬切合法的长推理 / 长流式响应，
 * 空闲超时不会。
 */
export class RequestStallGuard {
  /** 空闲阈值（毫秒）；`<=0` 表示不武装计时器，仅做外部信号转发。 */
  private readonly idleMs: number;
  /** 内部中止控制器：空闲计时器与外部信号都收敛到它，对外只暴露这一个 `signal`。 */
  private readonly controller = new AbortController();
  /** 当前已武装的计时器句柄（`touch`/`dispose` 会先清掉旧的再决定是否重武装）。 */
  private timer: ReturnType<typeof setTimeout> | undefined;
  /** 是否由**本守卫的空闲计时器**触发中止（调用方取消时为 false，二者须区别对待）。 */
  private stalled = false;
  /** 外部信号上挂的中止转发器（`dispose` 必须摘掉，见 {@link RequestStallGuard.dispose}）。 */
  private forwarder: (() => void) | undefined;
  /** 外部信号本体（`removeEventListener` 需要同一引用）。 */
  private external: AbortSignal | undefined;
  /** 是否已释放（释放后不得再因泄漏的定时器/监听器中止请求）。 */
  private disposed = false;

  /**
   * @param idleMs 空闲阈值毫秒数；`<=0` 时只转发外部信号、不武装计时器。
   * @param external 调用方自带的取消信号（可选）；其中止会联动中止本守卫。
   */
  public constructor(idleMs: number, external?: AbortSignal) {
    this.idleMs = idleMs;
    if (idleMs > 0) {
      this.arm();
    }
    if (external !== undefined) {
      this.forward(external);
    }
  }

  /** 交给 `fetch` 的中止信号（已合并空闲超时与调用方取消两种来源）。 */
  public get signal(): AbortSignal {
    return this.controller.signal;
  }

  /** 是否因**空闲超时**而中止。调用方主动取消时为 false —— 前者可重试，后者不可。 */
  public get timedOut(): boolean {
    return this.stalled;
  }

  /** 标记一次「有进展」：重置空闲计时器。收到响应头与每个 SSE 事件块时各调用一次。
   * @returns 无返回值。
   */
  public touch(): void {
    if (this.idleMs <= 0 || this.controller.signal.aborted) {
      return;
    }
    this.arm();
  }

  /** 释放计时器与外部信号监听（请求收尾必调）。不主动中止请求——中止只由超时或调用方取消触发。
   * @returns 无返回值。
   */
  public dispose(): void {
    this.disposed = true;
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    // 外部信号可能是**长寿命**的（会话级取消令牌被成百上千次请求复用）：不摘监听器的话，每次
    // 请求都会在这条信号上永久留下一个闭包（连带其 AbortController），且它随后可能在已 dispose 的
    // 控制器上触发 abort。必须成对移除。
    if (this.forwarder !== undefined && this.external !== undefined) {
      this.external.removeEventListener('abort', this.forwarder);
      this.forwarder = undefined;
      this.external = undefined;
    }
  }

  /** 武装（或重新武装）空闲计时器：到点即置 `stalled` 并中止，在飞 `fetch` 随之 reject。
   * @returns 无返回值。
   */
  private arm(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (this.disposed) {
        return;
      }
      this.stalled = true;
      this.controller.abort();
    }, this.idleMs);
    // 刻意**不** unref：本守卫存在的意义正是「把无限期挂死收敛为有界等待」，有界等待就需要
    // 事件循环活到计时器到点——unref 会在「除本计时器外无其他句柄」时让循环提前排空，
    // 于是 abort 永不触发，守卫在被需要的那一刻静默失效（实测：unref 后超时用例直接不中止）。
    // 计时器不会长期滞留：所有路径都在 finally 里 dispose，只有「请求始终不 settle」这一
    // 被修复的病态场景才会让进程多活到 idleMs 上界，而那正是我们想要的行为。
  }

  /** 转发外部取消信号；构造时已中止的情形也须立即联动（否则该取消会被静默吞掉）。
   * @param external 调用方自带的取消信号。
   * @returns 无返回值。
   */
  private forward(external: AbortSignal): void {
    if (external.aborted) {
      this.controller.abort(external.reason);
      return;
    }
    const forwarder = (): void => {
      if (!this.disposed) {
        this.controller.abort(external.reason);
      }
    };
    this.forwarder = forwarder;
    this.external = external;
    external.addEventListener('abort', forwarder, { once: true });
  }
}
