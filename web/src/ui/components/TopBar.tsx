// 顶栏：品牌 / 连接状态 / 移动端抽屉开关 / 主题切换 / 命令面板入口。
// 纯展示 + 回调，无内部状态。

import { React } from '../deps.js';
import { AppComponent } from '../base/AppComponent.js';

export interface TopBarProps {
  connected: boolean;
  adapter: string;
  onToggleTheme: () => void;
  onToggleLeft: () => void;
  onToggleRight: () => void;
  onCommandPalette: () => void;
}

/** 顶栏组件。 */
export class TopBar extends AppComponent<TopBarProps> {
  override render(): ReactElement {
    const { connected, adapter, onToggleTheme, onToggleLeft, onToggleRight, onCommandPalette } =
      this.props;
    return (
      <div className="topbar" role="banner">
        <div className="brand">
          <span className="logo" aria-hidden="true"></span> OmniHarness{' '}
          <small>{adapter || '…'}</small>
        </div>
        <button
          className="iconbtn drawer-toggle"
          title="会话 · 文件"
          aria-label="切换会话与文件面板"
          onClick={onToggleLeft}
        >
          ☰
        </button>
        <span className={'pill' + (connected ? ' on' : '')} role="status">
          <span className="dot" aria-hidden="true"></span> {connected ? '已连接' : '断开'}
        </span>
        <div className="spacer"></div>
        <button
          className="iconbtn"
          title="命令面板（Ctrl/Cmd+P）"
          aria-label="打开命令面板"
          onClick={onCommandPalette}
        >
          ⌘
        </button>
        <button
          className="iconbtn drawer-toggle"
          title="工具 · 设置 · 插件"
          aria-label="切换工具与设置面板"
          onClick={onToggleRight}
        >
          ⚙
        </button>
        <button
          className="iconbtn"
          title="切换主题"
          aria-label="切换浅色 / 深色主题"
          onClick={onToggleTheme}
        >
          🌓 主题
        </button>
      </div>
    );
  }
}
