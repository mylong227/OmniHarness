/**
 * 菜单键盘导航的**纯数学**（2026-10-28 前端可达性批②）：roving tabindex + 方向键。
 *
 * ## 为什么需要它
 *
 * 2026-10-28 上一批把四个弹层做成 Tab 可达（`tabIndex={0}` + Enter/Space），但菜单内部仍是
 * 「Tab 逐个走」：不是 WAI-ARIA 菜单的交互模型（菜单打开后应能用 ↑/↓ 在选项间移动，
 * Tab 只保留一个落点，Home/End 跳首尾，Esc 收起并把焦点还给触发器）。
 *
 * ## 边界
 *
 * 这里只算下标/动作，不碰 DOM（`document.activeElement` 与 `.focus()` 由组件侧接线），
 * 因此可以在零 DOM 的判据里直接测；DOM 那半段见各弹层的 `onKeyDown`。
 */

/** 方向键动作。 */
export type MenuKeyAction = 'next' | 'prev' | 'first' | 'last';

/**
 * 菜单键盘导航的纯计算：按键 → 动作、下标环绕、roving tabindex 落点。
 */
export class MenuFocusModel {
  /**
   * 按键 → 动作（非导航键返回 null，交回浏览器/组件自己处理）。
   * @param key `KeyboardEvent.key`
   * @returns 动作或 null
   */
  public static resolve(key: string): MenuKeyAction | null {
    switch (key) {
      case 'ArrowDown':
        return 'next';
      case 'ArrowUp':
        return 'prev';
      case 'Home':
        return 'first';
      case 'End':
        return 'last';
      default:
        return null;
    }
  }

  /**
   * 计算下一个焦点下标（**环绕**；空列表返回 -1）。
   * @param current 当前下标（-1 = 不在菜单内，向后从 0 开始、向前从末尾开始）
   * @param size 可导航项数量
   * @param backward 是否反向（↑）
   * @returns 下一个下标；`size <= 0` 时为 -1
   */
  public static step(current: number, size: number, backward: boolean): number {
    if (size <= 0) return -1;
    if (current < 0) return backward ? size - 1 : 0;
    return (current + (backward ? -1 : 1) + size) % size;
  }

  /**
   * 首/尾下标（空列表返回 -1）。
   * @param size 可导航项数量
   * @param edge 取首还是尾
   * @returns 下标或 -1
   */
  public static edge(size: number, edge: 'first' | 'last'): number {
    if (size <= 0) return -1;
    return edge === 'first' ? 0 : size - 1;
  }

  /**
   * roving tabindex：只有当前项在 Tab 序列里。
   * @param index 项下标
   * @param active 当前活动下标
   * @returns 0（可 Tab 到）或 -1
   */
  public static tabIndexFor(index: number, active: number): 0 | -1 {
    return index === active ? 0 : -1;
  }
}
