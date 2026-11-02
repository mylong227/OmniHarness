// 左栏会话列表的视图三态（时间分组 / 按工作区分组 / 并行任务卡）。
//
// 从 SessionPanel 抽出（零 React、纯函数）：面板只持有当前视图，循环语义放在这里，
// 视图切换按钮与列表渲染读的是同一个联合类型，避免「按钮说切到 X、列表渲染 Y」。

/** 左栏会话列表的三种视图。 */
export type PanelView = 'time' | 'ws' | 'cards';

/**
 * 三态循环：时间分组 → 按工作区分组 → 并行任务卡 → 时间分组。
 * @param view 当前视图
 * @returns 下一个视图（与 2026-10-07 起的既有循环顺序逐字一致）
 */
export function nextPanelView(view: PanelView): PanelView {
  return view === 'time' ? 'ws' : view === 'ws' ? 'cards' : 'time';
}
