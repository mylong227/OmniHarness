// 左侧图标导航栏（Codex 招牌元素）：细竖条 + 图标按钮，悬停显示文字提示。
// 点击切换 activePane，桌面端替代右栏 Tab 条；移动端隐藏，回退到右栏 Tab 条。
// 导航项数据为模块级常量（不可变），组件只负责渲染与回调。
// 纯展示组件（函数组件范式）：无内部状态、无副作用。

import { React } from '../deps.js';

/** NavRail 组件的入参。 */
export interface NavRailProps {
  /** 当前激活的面板标识。 */
  activePane: string;
  /** 切换面板。 */
  onSelect: (pane: string) => void;
}

/** 导航项。 */
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

/**
 * 左侧图标导航：渲染图标按钮列表，选中态以 aria-current 暴露给辅助技术。
 * @param props 组件入参
 * @returns 导航节点
 */
export function NavRail(props: NavRailProps): ReactElement {
  const { activePane, onSelect } = props;
  return (
    <div className="rail" role="navigation" aria-label="主导航">
      <div className="rail-logo" title="OmniHarness"></div>
      {ITEMS.map((it) => {
        const active = it.key === activePane;
        return (
          <button
            key={it.key}
            className={'rail-btn' + (active ? ' active' : '')}
            title={it.label}
            aria-label={it.label}
            aria-current={active ? 'page' : undefined}
            onClick={() => onSelect(it.key)}
          >
            <span className="rail-icon" aria-hidden="true">{it.icon}</span>
            <span className="rail-tip">{it.label}</span>
          </button>
        );
      })}
    </div>
  );
}
