// 侧栏页脚（截图式三栏壳）：连接状态 + 主题切换。
// 「设置」行已按用户反馈移除（2026-10-07）——设置仍可从右栏「全部面板」菜单一步到达。
// 「重连中」不显示红色「断开」的口径与原 TopBar 一致（EventSource 自动重连，抖动报红=假故障）。
// 纯展示组件（函数组件范式）：展示 + 回调，无内部状态、无副作用。

import { React } from '../deps.js';
import { icon } from '../models/Icon.js';

/** SidebarFooter 组件的入参。 */
export interface SidebarFooterProps {
  /** SSE 是否已连接（缺省三态时按它推）。 */
  connected: boolean;
  /** SSE 三态：`connecting` 显示黄色「重连中」，`closed`（宽限期后）才显示红色「断开」。 */
  streamState?: 'open' | 'connecting' | 'closed';
  /** 当前主题（决定主题按钮的图标）。 */
  theme: 'dark' | 'light';
  /** 切换主题（未提供则不渲染主题按钮）。 */
  onToggleTheme?: () => void;
}

/**
 * 侧栏页脚：连接徽标（role=status）+ 主题按钮。
 * @param props 组件入参
 * @returns 页脚节点
 */
export function SidebarFooter(props: SidebarFooterProps): ReactElement {
  const { connected, theme, onToggleTheme } = props;
  const state = props.streamState ?? (connected ? 'open' : 'closed');
  const label = state === 'open' ? '已连接' : state === 'connecting' ? '重连中' : '断开';
  const pillClass = 'pill' + (state === 'open' ? ' on' : state === 'connecting' ? ' warn' : '');
  return (
    <div className="side-foot">
      <span className={pillClass} role="status" aria-live="polite">
        <span className="dot" aria-hidden="true"></span> {label}
      </span>
      <span className="flex-spacer" aria-hidden="true"></span>
      {onToggleTheme === undefined ? null : (
        <button
          className="iconbtn"
          title="切换主题"
          aria-label="切换浅色 / 深色主题"
          onClick={onToggleTheme}
        >
          {icon(theme === 'light' ? 'moon' : 'sun', { size: 16 })}
        </button>
      )}
    </div>
  );
}
