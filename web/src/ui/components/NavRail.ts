// 左侧图标导航栏（Codex 招牌元素）：细竖条 + 图标按钮，悬停显示文字提示。
// 点击切换 activePane，桌面端替代右栏 Tab 条；移动端隐藏，回退到右栏 Tab 条。

import { html } from '../deps.js';

export interface NavRailProps {
  activePane: string;
  onSelect: (pane: string) => void;
}

const ITEMS: { key: string; icon: string; label: string }[] = [
  { key: 'tools', icon: '🧰', label: '工具' },
  { key: 'metrics', icon: '📈', label: '指标' },
  { key: 'settings', icon: '⚙️', label: '设置' },
  { key: 'plugins', icon: '🧩', label: '插件' },
  { key: 'graph', icon: '🕸', label: '编排' },
  { key: 'memory', icon: '🧠', label: '记忆' },
  { key: 'profiles', icon: '👤', label: '配置集' },
  { key: 'detail', icon: '🔍', label: '钻取' },
];

export function NavRail(props: NavRailProps): ReactElement {
  const { activePane, onSelect } = props;
  return html`<div className="rail">
    <div className="rail-logo" title="OmniHarness"></div>
    ${ITEMS.map(
      (it) =>
        html`<button
          key=${it.key}
          className=${'rail-btn' + (it.key === activePane ? ' active' : '')}
          title=${it.label}
          aria-label=${it.label}
          onClick=${() => onSelect(it.key)}
          ><span className="rail-icon">${it.icon}</span
          ><span className="rail-tip">${it.label}</span></button
        >`,
    )}
  </div>`;
}
