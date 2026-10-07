// 侧栏品牌头（截图式三栏壳）：Ω 品牌标识 + "OmniHarness" 字标 + 命令面板入口 + 收起按钮。
// 取代原全局 TopBar 的品牌职责——截图里没有独立顶栏，品牌属于会话侧栏的第一行。
//
// 字标是本产品自己的名字（2026-10-07 用户报「项目名称不是 deepseek，请修改掉」）：这里曾照搬上游
// dsh 的字标 "deepseek HARNESS"，既不是本产品名，也把品牌行撑到 284px 宽（列宽 248px）——**把
// 「收起」按钮挤出左栏可视区**（`elementFromPoint` 命中的是隔壁中栏），用户因此「左栏收不起来」。
// 现在字标 = OmniHarness，且样式层给字标留了可收缩 + 省略号（见 shell.css `.side-wordmark`）。
//
// 纯展示组件（函数组件范式）：展示 + 回调，无内部状态、无副作用。

import { React } from '../deps.js';
import { icon } from '../models/Icon.js';

/** SidebarHeader 组件的入参。 */
export interface SidebarHeaderProps {
  /** 侧栏是否已收成图标条（收起时只留品牌标识与展开按钮）。 */
  rail: boolean;
  /** 收起 / 展开侧栏（快捷键 `[` 的同一开关）。 */
  onToggleRail: () => void;
  /** 打开命令面板（原 TopBar 的入口收编于此；快捷键 Ctrl/Cmd+P 仍可用）。 */
  onOpenPalette?: () => void;
}

/**
 * 侧栏品牌头：渲染品牌行；`rail` 态退化为只留标识与展开按钮的窄行。
 * @param props 组件入参
 * @returns 品牌头节点
 */
export function SidebarHeader(props: SidebarHeaderProps): ReactElement {
  const { rail, onToggleRail, onOpenPalette } = props;
  return (
    <div className="side-brand">
      <span className="brand-mark" aria-hidden="true">
        Ω
      </span>
      {rail ? null : (
        <span className="side-wordmark" title="OmniHarness">
          OmniHarness
        </span>
      )}
      <span className="flex-spacer" aria-hidden="true"></span>
      {rail || onOpenPalette === undefined ? null : (
        <button
          className="iconbtn"
          title="命令面板（Ctrl/Cmd+P）"
          aria-label="打开命令面板"
          onClick={onOpenPalette}
        >
          {icon('command', { size: 16 })}
        </button>
      )}
      <button
        className="iconbtn rail-toggle"
        title={rail ? '展开侧栏（[）' : '收起侧栏（[）'}
        aria-label={rail ? '展开侧栏' : '收起侧栏'}
        onClick={onToggleRail}
      >
        {rail ? '»' : '«'}
      </button>
    </div>
  );
}
