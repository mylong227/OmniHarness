// 模态焦点陷阱：Tab / Shift+Tab 在框内绕圈，别让焦点跑到背后的页面上。
//
// ## 为什么需要它（2026-10-17 补的真实缺陷）
//
// 设置模态此前只有 `role="dialog"` + `aria-modal="true"` + Esc 关闭，**没有焦点陷阱**：
// 打开后 Tab 会一路走出模态、落到左栏的会话列表和输入框上——屏幕阅读器与纯键盘用户
// 因此会"在模态开着的情况下操作到背后的界面"。这是 WCAG 2.4.3（焦点顺序）与
// 对话框模式的实质要求，不是可选的锦上添花。
//
// `DialogHost`（确认/输入弹窗）此前有一套手写实现，但它靠显式 refs 圈定 2-3 个元素；
// 设置模态有几十个可聚焦元素（分栏、输入框、按钮），必须按 DOM 查询。
//
// ## 为什么把"绕圈计算"拆成纯函数
//
// `nextTabIndex` 不含任何 DOM 依赖，因此可以在本仓的**零 DOM 判据**里直接测
// （`web/test/focusTrap.test.mjs`）；DOM 那半段只负责查元素、比对 `document.activeElement`。

/**
 * 可聚焦元素的选择器。
 *
 * 为什么显式列 `:not([disabled])` / `:not([tabindex="-1"])`：`querySelectorAll` 不会
 * 帮我们排除它们，而把禁用按钮算进循环会让 Tab 停在按不动的元素上、光标"消失"。
 * `[tabindex="-1"]` 是**程序性可聚焦**（如容器本身），不属于 Tab 序列。
 */
const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

/**
 * 在框内绕圈时，下一个应聚焦的下标（**纯函数**，可零 DOM 单测）。
 *
 * @param size 可聚焦元素个数（<=0 表示框内没有可聚焦元素）
 * @param current 当前焦点在列表中的下标；**-1 表示焦点不在框内**
 * @param backward 是否反向（Shift+Tab）
 * @returns 下一个下标；`size <= 0` 时返回 -1（调用方据此决定是否兜底聚焦容器）
 */
export function nextTabIndex(size: number, current: number, backward: boolean): number {
  if (size <= 0) return -1;
  // 焦点不在框内（例如打开瞬间、或用户点了遮罩）：向后从第一个进、向前从最后一个进。
  if (current < 0) return backward ? size - 1 : 0;
  return (current + (backward ? -1 : 1) + size) % size;
}

/**
 * 取容器内**可见且当前可聚焦**的元素（按 DOM 顺序）。
 *
 * 为什么要过滤"不可见"：设置模态的厂商卡默认折叠，折叠面板里的按钮仍在 DOM 里但
 * 不可见；把隐藏元素算进循环，Tab 会停在看不见的地方。用 `offsetParent !== null`
 * 判可见（`position: fixed` 的祖先会让它为 null，故同时接受 `getClientRects().length`）。
 *
 * @param root 容器（模态根元素）
 * @returns 可聚焦元素数组
 */
export function focusableWithin(root: HTMLElement | null): HTMLElement[] {
  if (root === null) return [];
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (el) => el.getClientRects().length > 0,
  );
}

/**
 * 处理一次 Tab：需要"绕回"时移动焦点并返回 true，否则返回 false 让浏览器自然移动。
 *
 * @param root 容器（模态根元素）
 * @param backward 是否 Shift+Tab
 * @returns 是否已接管（true 时调用方应 `preventDefault`）
 */
export function trapTab(root: HTMLElement | null, backward: boolean): boolean {
  const list = focusableWithin(root);
  const index = list.indexOf(document.activeElement as HTMLElement);
  const next = nextTabIndex(list.length, index, backward);
  if (next < 0) {
    // 框内没有可聚焦元素：把焦点交给容器本身（容器需带 tabindex="-1"），
    // 至少不会让焦点留在背后的页面上。
    root?.focus();
    return true;
  }
  // 焦点本来就在框内、且不是首尾：交给浏览器按自然顺序移动（更符合原生手感）。
  if (index >= 0 && next === index + (backward ? -1 : 1)) return false;
  list[next]?.focus();
  return true;
}
