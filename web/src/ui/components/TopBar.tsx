// 顶栏：品牌 / 连接状态 / 移动端抽屉开关 / 主题切换 / 命令面板入口。
// 纯展示组件（函数组件范式）：展示 + 回调，无内部状态、无副作用。

import { React } from '../deps.js';

/** TopBar 组件的入参。 */
export interface TopBarProps {
  /** SSE 是否已连接（决定状态灯颜色与文案）。 */
  connected: boolean;
  /**
   * SSE 三态（可选：缺省时按 `connected` 推）。`connecting` = 连接中 / 断线重连中，
   * 显示成黄色的「重连中」——**不显示红色的「断开」**：EventSource 本就自动重连，
   * 瞬时抖动报红等于制造假故障（用户报的「显示区域会出现显示断开」）。
   */
  streamState?: 'open' | 'connecting' | 'closed';
  /** 模型适配器摘要文案（如 `openai · gpt-4o`）。 */
  adapter: string;
  /** 切换浅色 / 深色主题。 */
  onToggleTheme: () => void;
  /** 切换左侧（会话 · 文件）面板。 */
  onToggleLeft: () => void;
  /** 切换右侧（工具 · 设置）面板。 */
  onToggleRight: () => void;
  /** 打开命令面板。 */
  onCommandPalette: () => void;
}

/**
 * 顶栏：渲染品牌、连接状态与各面板入口按钮。
 * @param props 组件入参
 * @returns 顶栏节点
 */
export function TopBar(props: TopBarProps): ReactElement {
  const { connected, adapter, onToggleTheme, onToggleLeft, onToggleRight, onCommandPalette } =
    props;
  const state = props.streamState ?? (connected ? 'open' : 'closed');
  const label = state === 'open' ? '已连接' : state === 'connecting' ? '重连中' : '断开';
  const pillClass = 'pill' + (state === 'open' ? ' on' : state === 'connecting' ? ' warn' : '');
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
      <span className={pillClass} role="status" aria-live="polite">
        <span className="dot" aria-hidden="true"></span> {label}
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
