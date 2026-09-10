// 左侧图标导航栏（Codex 招牌元素）：细竖条 + 图标按钮，悬停显示文字提示。
// 点击切换 activePane，桌面端替代右栏 Tab 条；移动端隐藏，回退到右栏 Tab 条。
// 导航项数据为模块级常量（不可变），组件只负责渲染与回调。

import { React } from '../deps.js';

export interface NavRailProps {
  activePane: string;
  onSelect: (pane: string) => void;
}

interface NavItem {
  readonly key: string;
  readonly icon: string;
  readonly label: string;
}

const ITEMS: readonly NavItem[] = [
  { key: 'tools', icon: '🧰', label: '工具' },
  { key: 'metrics', icon: '📈', label: '指标' },
  { key: 'settings', icon: '⚙️', label: '设置' },
  { key: 'plugins', icon: '🧩', label: '插件' },
  { key: 'graph', icon: '🕸', label: '编排' },
  { key: 'memory', icon: '🧠', label: '记忆' },
  { key: 'profiles', icon: '👤', label: '配置集' },
  { key: 'detail', icon: '🔍', label: '钻取' },
  { key: 'rollback', icon: '⏪', label: '回滚' },
];

/** 左侧图标导航组件。 */
export class NavRail extends React.Component<NavRailProps> {
  /** 渲染单个导航按钮：选中态由 activePane 决定。 */
  private renderItem(it: NavItem): ReactElement {
    const { activePane, onSelect } = this.props;
    return (
      <button
        key={it.key}
        className={'rail-btn' + (it.key === activePane ? ' active' : '')}
        title={it.label}
        aria-label={it.label}
        onClick={() => onSelect(it.key)}
      >
        <span className="rail-icon">{it.icon}</span>
        <span className="rail-tip">{it.label}</span>
      </button>
    );
  }

  override render(): ReactElement {
    return (
      <div className="rail" role="navigation" aria-label="主导航">
        <div className="rail-logo" title="OmniHarness"></div>
        {ITEMS.map((it) => this.renderItem(it))}
      </div>
    );
  }
}
