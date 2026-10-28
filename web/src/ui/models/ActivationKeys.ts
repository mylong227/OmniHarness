/**
 * 「非按钮元素」的键盘激活语义（2026-10-28 前端可达性批）。
 *
 * ## 为什么需要它
 *
 * 输入区的四个弹层触发器（模型 / 权限 / 添加 / 上下文容量）与菜单项都是
 * `div role="button"` / `div role="option"`——`role` 只告诉读屏软件「它是个按钮」，
 * **不会**让浏览器给它 Enter/Space 的激活行为，也不会让它进入 Tab 序列（没有 `tabIndex`）。
 * 结果是纯键盘用户**打不开这四个面板**（审计原文：「纯键盘用户打不开模型、权限、附加、
 * 上下文容量面板」）。
 *
 * 本类只做一件事：判定「这个按键是否应激活」并统一 `preventDefault`（Space 不滚页、
 * Enter 不触发表单提交）。`tabIndex` 由各组件自己加——是否进 Tab 序列是布局决策，
 * 不该被一个工具类隐式决定。
 *
 * ## 为什么不直接换 `<button>`
 *
 * 四个触发器的样式都挂在原标签上（`.mp` / `.addmenu` / `.dd.perm` / `.cap`），换成
 * `<button>` 需要同时补 UA 样式复位（背景/边框/字体/对齐），在**没有真机视觉回归**的
 * 前提下属于「为了语义正确引入视觉风险」。`role=button` + `tabIndex=0` + 本类的
 * Enter/Space 处理在 WCAG 2.1 下等价可用（2.1.1 键盘可操作）。
 */
export class ActivationKeys {
  /**
   * 该按键是否应触发激活（Enter / Space；兼容旧浏览器上报的 `Spacebar`）。
   * @param key `KeyboardEvent.key`
   * @returns 是激活键为 true
   */
  public static isActivationKey(key: string): boolean {
    return key === 'Enter' || key === ' ' || key === 'Spacebar';
  }

  /**
   * 是激活键则 `preventDefault` 并执行动作。
   * @param event 键盘事件（最小结构：只需 `key` 与 `preventDefault`）
   * @param action 激活动作
   * @returns 真的激活了为 true（调用方可据此跳过其它分支）
   */
  public static activate(event: { readonly key: string; preventDefault(): void }, action: () => void): boolean {
    if (!ActivationKeys.isActivationKey(event.key)) return false;
    event.preventDefault();
    action();
    return true;
  }
}
