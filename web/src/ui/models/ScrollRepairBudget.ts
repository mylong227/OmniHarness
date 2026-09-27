// 滚动空洞修复的**预算**：把「写回 scrollTop」限制在「单位用户交互内至多 N 次」。
//
// ## 为什么必须有它（2026-09-27 React #185「Maximum update depth exceeded」）
//
// 写回 `scrollTop` 发生在 `useLayoutEffect` 里（见 StreamView 的锚定校正），而写回会改变虚拟窗口
// ⇒ 布局效应再次运行 ⇒ 只要校正量始终 > 1px，就形成
// `render → layoutEffect → setState(scrollTop) → render …` 的**同步**死循环：React 抛 #185，
// 而页面主线程被占满（真机实测：连 CDP 的 `Runtime.evaluate` 都得不到响应、`Debugger.pause` 也
// 无法中断，探针 5 分钟零输出）。用户截图里的错误边界面板即此形态。
//
// 因此「校正是否收敛」不能只靠**几何上的自愈**（理论上会收敛，实测某些会话状态下不会），
// 必须有一条**结构上可证的**上界：预算只在「用户自己滚动」（或贴底自动滚动改变了位置）时补充，
// 而校正本身写回的位置会被记下来，其触发的 scroll 事件**不补充预算** ⇒ 循环无法自我续期。
//
// 纯计算、零 DOM、零 React：可直接单测（见 web/test/scrollRepairBudget.test.mjs）。

/** 默认「每次用户滚动允许的校正次数」：一次够修空洞，两次容忍测量再次落地的余量。 */
const DEFAULT_MAX = 2;

/** 判定「这次 scroll 是我自己写回造成的」的容差（px）：浏览器可能把写回值取整。 */
const SELF_SCROLL_EPSILON = 1;

/** 滚动校正预算：纯状态机，`noteScroll` 补充、`take` 消耗。 */
export class ScrollRepairBudget {
  /** 每次补充后的可用次数（构造时固定，保证上界可证）。 */
  private readonly max: number;
  /** 当前剩余次数。 */
  private remaining: number;
  /** 上一次**我们自己**写回的 scrollTop（null = 尚无）。 */
  private lastSelfSet: number | null = null;

  /**
   * @param max 每次补充可用次数（<=0 时按 0 处理，即彻底禁用校正）
   */
  public constructor(max: number = DEFAULT_MAX) {
    this.max = max > 0 ? Math.floor(max) : 0;
    this.remaining = this.max;
  }

  /**
   * 记一次滚动事件：**只有不是我们自己写回造成的**才补充预算。
   * @param scrollTop 本次滚动事件报告的 scrollTop
   * @returns 无返回值
   */
  public noteScroll(scrollTop: number): void {
    if (this.lastSelfSet === null || Math.abs(scrollTop - this.lastSelfSet) > SELF_SCROLL_EPSILON) {
      this.remaining = this.max;
      this.lastSelfSet = null;
    }
  }

  /**
   * 尝试消耗一次预算（仅在真的准备写回 scrollTop 时调用）。
   * @param selfSetValue 我们即将写回的值（供识别随后由它触发的 scroll 事件）
   * @returns 允许写回返回 true；预算耗尽返回 false
   */
  public take(selfSetValue: number): boolean {
    if (this.remaining <= 0) return false;
    this.remaining -= 1;
    this.lastSelfSet = selfSetValue;
    return true;
  }

  /**
   * 当前剩余次数（观测 / 单测用）。
   * @returns 剩余次数
   */
  public remainingCount(): number {
    return this.remaining;
  }
}
