/**
 * 会话数据版本号（`AppState.sessionTick`）的去抖器。
 *
 * 单独成类的理由：`SessionController` 已到"上帝类"阈值边缘（>25 方法），
 * 而"什么时候 +1 / 如何合并同一批事件"是可以独立测试的纯调度逻辑：
 *   · `now()`     —— 会话切换 / 新建：立即 +1（全量数据一次性变化）；
 *   · `schedule()` —— 回合推进：300ms 去抖后 +1（合并同一批 tool_result/model 事件）。
 */

/** 会话数据版本号去抖器。 */
export class SessionTicker {
  /** 当前待触发的定时器（null = 没有排队中的 +1）。 */
  private timer: ReturnType<typeof setTimeout> | null = null;

  /**
   * @param bump 版本号 +1 的落点（由宿主注入 `patch`）
   * @param delayMs 去抖窗口（毫秒）
   */
  public constructor(
    private readonly bump: () => void,
    private readonly delayMs = 300,
  ) {}

  /**
   * 安排一次去抖 +1：窗口内重复调用只保留最后一次。
   * @returns 无
   */
  public schedule(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.bump();
    }, this.delayMs);
  }

  /**
   * 立即 +1（并取消排队中的去抖，避免同一变化触发两次）。
   * @returns 无
   */
  public now(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.bump();
  }
}
