// 桌面标题条（win32 隐藏系统标题栏后的一体化顶栏，参考 ZCode 桌面端的窗口形态）：
// 整条是拖拽区（-webkit-app-region: drag），右端自绘「最小化 / 最大化 / 关闭」。
//
// 只在「桌面桥存在且壳上报 windowFrame === 'hidden'」时渲染；浏览器与旧版壳
// （没有该字段/方法）一律返回 null——窗口控制仍由系统标题栏承担，不出现第二条 chrome。
// 纯展示组件（函数组件范式）：无内部状态；最大化/还原细节（双击、图标形态）由 CSS + 事件承担。

import type { ReactElement } from 'react';
import { desktopBridge } from '../../core/desktop/DesktopBridge.ts';
import { t } from '../i18n/i18n.ts';

/**
 * 桌面标题条：拖拽区 + 自绘窗口控制按钮。
 * @returns 标题条节点；非桌面壳或壳未隐藏系统标题栏时为 null
 */
export function TitlebarStrip(): ReactElement | null {
  const bridge = desktopBridge();
  if (bridge === null || bridge.windowFrame !== 'hidden') return null;
  const canControl =
    typeof bridge.minimizeWindow === 'function' &&
    typeof bridge.toggleMaximizeWindow === 'function' &&
    typeof bridge.closeWindow === 'function';
  return (
    <div
      className="titlebar"
      onDoubleClick={() => {
        void bridge.toggleMaximizeWindow?.().catch(() => undefined);
      }}
    >
      {canControl ? (
        <div className="titlebar-controls">
          <button
            className="tb-btn"
            title={t('最小化')}
            aria-label={t('最小化窗口')}
            onClick={() => {
              void bridge.minimizeWindow?.().catch(() => undefined);
            }}
          >
            {'\u2500'}
          </button>
          <button
            className="tb-btn"
            title={t('最大化 / 还原')}
            aria-label={t('最大化或还原窗口')}
            onClick={() => {
              void bridge.toggleMaximizeWindow?.().catch(() => undefined);
            }}
          >
            {'\u25A1'}
          </button>
          <button
            className="tb-btn tb-close"
            title={t('关闭窗口')}
            aria-label={t('关闭窗口')}
            onClick={() => {
              void bridge.closeWindow?.().catch(() => undefined);
            }}
          >
            {'\u2715'}
          </button>
        </div>
      ) : null}
    </div>
  );
}
