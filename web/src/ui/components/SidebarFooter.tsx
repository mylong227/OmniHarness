// 侧栏页脚（截图式三栏壳）：连接状态 + 设置 + 主题切换。
//
// 2026-10-17 起「设置」回到页脚（用户要求）：设置从右栏面板改为**模态**后，
// 需要一个固定入口，而页脚是唯一在任何面板状态下都可见的一行。
// 历史注记：旧注释写着「设置行已按用户反馈移除（2026-10-07）」——那次移除的前提是
// 「设置仍可从右栏全部面板菜单一步到达」，而本轮把设置移出面板列表后，那个前提不成立了，
// 所以入口必须回到固定位置。别再按旧注释把它删掉。
//
// 「重连中」不显示红色「断开」的口径与原 TopBar 一致（EventSource 自动重连，抖动报红=假故障）。
// 纯展示组件（函数组件范式）：展示 + 回调，无内部状态、无副作用。

import * as React from 'react';
import { icon } from '../models/Icon.js';
import { t } from '../i18n/i18n.js';

/** SidebarFooter 组件的入参。 */
export interface SidebarFooterProps {
  /** SSE 是否已连接（缺省三态时按它推）。 */
  connected: boolean;
  /** SSE 三态：`connecting` 显示「重连中」，`closed`（宽限期后）才显示「断开」。 */
  streamState?: 'open' | 'connecting' | 'closed';
  /** 当前主题（决定主题按钮的图标）。 */
  theme: 'dark' | 'light';
  /** 切换主题（未提供则不渲染主题按钮）。 */
  onToggleTheme?: () => void;
  /** 打开设置模态（未提供则不渲染设置按钮）。 */
  onOpenSettings?: () => void;
}

/**
 * 侧栏页脚：连接徽标（role=status）+ 设置 + 主题按钮。
 * @param props 组件入参
 * @returns 页脚节点
 */
export function SidebarFooter(props: SidebarFooterProps): ReactElement {
  const { connected, theme, onToggleTheme, onOpenSettings } = props;
  const state = props.streamState ?? (connected ? 'open' : 'closed');
  const label = state === 'open' ? t('已连接') : state === 'connecting' ? t('重连中') : t('断开');
  const pillClass = 'pill' + (state === 'open' ? ' on' : state === 'connecting' ? ' warn' : '');
  return (
    <div className="side-foot">
      <span className={pillClass} role="status" aria-live="polite">
        <span className="dot" aria-hidden="true"></span> {label}
      </span>
      <span className="flex-spacer" aria-hidden="true"></span>
      {onOpenSettings === undefined ? null : (
        <button
          className="iconbtn"
          title={t('设置')}
          aria-label={t('打开设置')}
          onClick={onOpenSettings}
        >
          {icon('gear', { size: 16 })}
        </button>
      )}
      {onToggleTheme === undefined ? null : (
        <button
          className="iconbtn"
          title={t('切换主题')}
          aria-label={t('切换浅色 / 深色主题')}
          onClick={onToggleTheme}
        >
          {icon(theme === 'light' ? 'moon' : 'sun', { size: 16 })}
        </button>
      )}
    </div>
  );
}
