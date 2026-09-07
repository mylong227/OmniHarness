// 顶栏：品牌 / 连接状态 / 移动端抽屉开关 / 主题切换。纯展示 + 回调。

import { html } from '../deps.js';

export interface TopBarProps {
  connected: boolean;
  adapter: string;
  onToggleTheme: () => void;
  onToggleLeft: () => void;
  onToggleRight: () => void;
}

export function TopBar(props: TopBarProps): ReactElement {
  const { connected, adapter, onToggleTheme, onToggleLeft, onToggleRight } = props;
  return html`<div className="topbar">
    <div className="brand">
      <span className="logo"></span> OmniHarness <small>${adapter || '…'}</small>
    </div>
    <button className="iconbtn drawer-toggle" title="会话 · 文件" onClick=${onToggleLeft}>☰</button>
    <span className=${'pill' + (connected ? ' on' : '')}>
      <span className="dot"></span> ${connected ? '已连接' : '断开'}
    </span>
    <div className="spacer"></div>
    <button className="iconbtn drawer-toggle" title="工具 · 设置 · 插件" onClick=${onToggleRight}>⚙</button>
    <button className="iconbtn" title="切换主题" onClick=${onToggleTheme}>🌓 主题</button>
  </div>`;
}
