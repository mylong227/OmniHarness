// 浮层（右键菜单等）的**贴边翻转**：把「鼠标坐标」换算成「完全落在视口内」的左上角坐标。
//
// ## 为什么需要它（2026-09-27 用户点名「右键菜单贴近视口右下角时会溢出屏幕」）
//
// 菜单是按鼠标坐标 `position:fixed` 放的：鼠标在右下角时 `left/top` 直接等于坐标 ⇒ 菜单右半边 /
// 下半截跑到视口外，用户看不到「删除…」等项。做法与系统右键菜单一致：**放不下就朝反方向翻**，
// 翻完仍放不下（菜单比视口还大）则夹到留白内 —— 保证「菜单整体可见」这一条不变量。
//
// 纯计算、零 DOM、零 React：可直接单测（见 web/test/menuPlacement.test.mjs）。

/** 菜单与视口边缘的最小留白（px）。 */
const MARGIN = 8;

/** 矩形尺寸（宽高，px）。 */
export interface MenuSize {
  readonly w: number;
  readonly h: number;
}

/** 视口尺寸（宽高，px）。 */
export interface ViewportSize {
  readonly w: number;
  readonly h: number;
}

/** 浮层定位器。 */
export class MenuPlacement {
  /**
   * 由鼠标坐标算出菜单左上角坐标（完全落在视口内）。
   *
   * 规则（与桌面系统右键菜单同口径）：
   * 1. 默认贴鼠标右下方向；
   * 2. 右侧放不下则**向左翻**（菜单右缘对齐鼠标），仍放不下则夹到右留白；
   * 3. 下方放不下则**向上翻**（菜单下缘对齐鼠标），仍放不下则夹到下留白；
   * 4. 菜单比视口还大时，夹到左上留白（此时必然溢出，但保证左/上可见）。
   * @param x 鼠标 x（视口坐标）
   * @param y 鼠标 y（视口坐标）
   * @param size 菜单实际尺寸
   * @param viewport 视口尺寸（通常 `window.innerWidth/innerHeight`）
   * @returns 菜单左上角坐标
   */
  public static clamp(x: number, y: number, size: MenuSize, viewport: ViewportSize): { x: number; y: number } {
    const maxX = viewport.w - MARGIN;
    const maxY = viewport.h - MARGIN;
    let left = x;
    if (left + size.w > maxX) left = x - size.w; // 向左翻
    if (left + size.w > maxX) left = maxX - size.w; // 仍放不下 ⇒ 夹到右留白
    if (left < MARGIN) left = MARGIN;
    let top = y;
    if (top + size.h > maxY) top = y - size.h; // 向上翻
    if (top + size.h > maxY) top = maxY - size.h;
    if (top < MARGIN) top = MARGIN;
    return { x: Math.round(left), y: Math.round(top) };
  }
}
