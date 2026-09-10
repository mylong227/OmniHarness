// 渐进式文本揭示：把「长文本的字符级渐进呈现」从 React 组件中剥离出来。
//
// 内容为真实文本、非伪造 token：只是把已有文本按节奏切片推送，用于模拟流式观感。
// 纯逻辑（不依赖 React），定时器句柄由外部注入，便于单测与在组件卸载时彻底停止。

/** 单帧推进节奏：起步至少 12 字，长文本每帧约 1/30。 */
const STEP_MS = 22;
const MIN_STEP = 12;
/** 短于此长度直接全量显示，避免无谓重渲染。 */
const SHORT_TEXT = 240;

/** 文本揭示器：按节奏把 text 切片回调给订阅方。 */
export class TextRevealer {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private cursor = 0;
  private current = '';

  /**
   * @param onUpdate 每次推进的回调（收到当前应显示的子串）。
   * @param schedule 定时器注入点（默认 setTimeout；单测可换成手动时钟）。
   */
  public constructor(
    private readonly onUpdate: (shown: string) => void,
    private readonly schedule: (fn: () => void, ms: number) => ReturnType<typeof setTimeout> = setTimeout,
  ) {}

  /** 当前已揭示的子串。 */
  public get shown(): string {
    return this.current === '' ? '' : this.current.slice(0, this.cursor);
  }

  /** 是否正在推进。 */
  public get running(): boolean {
    return this.timer !== null;
  }

  /**
   * 启动揭示：animate=false 或文本过短时直接全量推送（一次到位）。
   * 重复调用会先停掉上一轮，避免多个定时器并存互相覆盖。
   */
  public start(text: string, animate: boolean): void {
    this.stop();
    this.current = text;
    if (!animate || text.length <= SHORT_TEXT) {
      this.cursor = text.length;
      this.onUpdate(text);
      return;
    }
    // 从 40% 处起步：已经生成的内容不该让用户从头再看一遍。
    this.cursor = Math.floor(text.length * 0.4);
    this.onUpdate(this.shown);
    this.tick();
  }

  /** 停止推进（组件卸载 / 新文本到来时必须调用，否则定时器泄漏）。 */
  public stop(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private tick(): void {
    const step = Math.max(MIN_STEP, Math.ceil(this.current.length / 30));
    this.timer = this.schedule(() => {
      this.timer = null;
      this.cursor = Math.min(this.current.length, this.cursor + step);
      this.onUpdate(this.shown);
      if (this.cursor < this.current.length) this.tick();
    }, STEP_MS);
  }
}
