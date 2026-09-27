// 滚动空洞修复的**预算**：把「因修复而触发的重渲染」限制在「单位用户交互内至多 N 次」。
//
// ## 为什么必须有它（2026-09-27 用户截图的 React #185「Maximum update depth exceeded」）
//
// 空洞修复会 `setState`，而 setState 会重算窗口、让布局效应再跑一次；只要「修复 → 覆盖率仍不达标」
// 一直成立，就形成 `render → layoutEffect → setState → render` 的**同步**循环（React 抛 #185，
// 页面主线程被占满）。几何上「本该收敛」不足以保证（实测有会话状态不收敛），故必须有预算：
// **预算只在用户自己滚动时补充** ⇒ 循环无法自我续期（可证的终止性）。
//
// 纯计算、零 DOM、零 React：可直接单测（见 web/test/scrollRepairBudget.test.mjs）。

/** 默认「每次用户滚动允许的修复次数」。 */
const DEFAULT_MAX = 2;

/** 空洞修复预算：纯状态机，`noteScroll` 补充、`take` 消耗。 */
export class ScrollRepairBudget {
  /** 每次补充后的可用次数（构造时固定，保证上界可证）。 */
  private readonly max: number;
  /** 当前剩余次数。 */
  private remaining: number;

  /**
   * @param max 每次补充可用次数（<=0 时按 0 处理，即彻底禁用修复）
   */
  public constructor(max: number = DEFAULT_MAX) {
    this.max = max > 0 ? Math.floor(max) : 0;
    this.remaining = this.max;
  }

  /**
   * 记一次**用户滚动**：补满预算。
   * @returns 无返回值
   */
  public noteScroll(): void {
    this.remaining = this.max;
  }

  /**
   * 尝试消耗一次预算（仅在真的要因修复而 setState 时调用）。
   * @returns 允许修复返回 true；预算耗尽返回 false
   */
  public take(): boolean {
    if (this.remaining <= 0) return false;
    this.remaining -= 1;
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
