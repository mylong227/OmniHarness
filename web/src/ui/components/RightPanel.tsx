// 右栏容器：标签页入口 + 当前激活面板插槽。各具体面板由 App 根据 activePane 选择后作为 children 注入，
// 本组件只负责标签切换与移动端抽屉态，不做业务逻辑。
// 纯展示组件（函数组件范式）：无内部状态、无副作用。
//
// a11y（B4）：标签条按 WAI-ARIA Tabs 模式接线——tablist / tab / tabpanel + aria-selected + roving tabindex，
// 左右方向键在标签间移动，Enter/Space 激活；DOM 是 div，故键盘行为必须显式实现（浏览器不会白送）。
// 注：桌面端（>880px）标签条 display:none（改用 NavRail），桌面读屏用户走 rail 的 aria-current。

import { React } from '../deps.js';

/** 右栏面板内容容器 id（标签的 aria-controls 指向它）。 */
const PANE_ID = 'right-pane';

/** RightPanel 组件的入参。 */
export interface RightPanelProps {
  /** 当前激活的面板标识。 */
  activePane: string;
  /** 切换面板。 */
  onSelect: (pane: string) => void;
  /** 右栏是否展开（移动端抽屉态）。 */
  open: boolean;
  /** 当前面板内容（由 App 按 activePane 选择后注入）。 */
  children: ReactNode;
  /** 移动端内联样式覆盖。 */
  style?: Record<string, string>;
}

/** 右栏标签项。 */
interface TabItem {
  readonly key: string;
  readonly label: string;
}

const TABS: readonly TabItem[] = [
  { key: 'tools', label: '工具' },
  { key: 'changes', label: '变更' },
  { key: 'rollback', label: '回滚' },
  { key: 'metrics', label: '指标' },
  { key: 'settings', label: '设置' },
  { key: 'plugins', label: '插件' },
  { key: 'graph', label: '编排' },
  { key: 'memory', label: '记忆' },
  { key: 'profiles', label: '配置集' },
  { key: 'file', label: '文件' },
  { key: 'detail', label: '⤢ 钻取' },
];

/**
 * 右栏容器：渲染标签条（tablist）与当前面板内容（tabpanel）。
 * @param props 组件入参
 * @returns 右栏节点
 */
export function RightPanel(props: RightPanelProps): ReactElement {
  const { activePane, onSelect, open, children, style } = props;

  /**
   * 标签键盘行为：左右方向键移动并激活，Enter/Space 激活当前标签。
   * @param e 键盘事件
   * @param i 当前标签下标
   * @returns 无
   */
  const onTabKey = (e: KeyboardEvent, i: number): void => {
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault();
      const step = e.key === 'ArrowRight' ? 1 : -1;
      const next = TABS[(i + step + TABS.length) % TABS.length];
      if (next) onSelect(next.key);
      return;
    }
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onSelect(TABS[i].key);
    }
  };

  /** 渲染单个标签：选中态由 activePane 决定（roving tabindex：只有选中项进 Tab 序列）。 */
  const renderTab = (t: TabItem, i: number): ReactElement => {
    const active = t.key === activePane;
    return (
      <div
        key={t.key}
        id={'tab-' + t.key}
        className={'tab' + (active ? ' active' : '')}
        role="tab"
        aria-selected={active ? 'true' : 'false'}
        aria-controls={PANE_ID}
        tabIndex={active ? 0 : -1}
        onClick={() => onSelect(t.key)}
        onKeyDown={(e: KeyboardEvent) => onTabKey(e, i)}
      >
        {t.label}
      </div>
    );
  };

  return (
    <div className={'col right' + (open ? ' open' : '')} style={style}>
      <div className="tabs" role="tablist" aria-label="右侧面板">
        {TABS.map((t, i) => renderTab(t, i))}
      </div>
      <div
        className="pane active"
        id={PANE_ID}
        role="tabpanel"
        aria-labelledby={'tab-' + activePane}
        tabIndex={-1}
      >
        {children}
      </div>
    </div>
  );
}
