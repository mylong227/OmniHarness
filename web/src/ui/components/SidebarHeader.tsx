// 侧栏品牌头（截图式三栏壳）：Ω 品牌标识 + "OmniHarness" 字标。
// 取代原全局 TopBar 的品牌职责——截图里没有独立顶栏，品牌属于会话侧栏的第一行。
//
// 2026-10-26 用户按参考图要求：删掉品牌行右侧的**命令面板按钮**与**收起（«）按钮**，
// 右栏头的「全部面板」按钮同时删除（三处 chrome 图标退场）。命令面板仍可用 Ctrl/Cmd+P；
// 左栏图标条仍保留键盘入口 `[`（不再有可见按钮）。
//
// 字标是本产品自己的名字（2026-10-07 用户报「项目名称不是上游产品名，请修改掉」）：这里曾照搬上游
// 产品的字标，既不是本产品名，也把品牌行撑到 284px 宽（列宽 248px）。现在字标 = OmniHarness，
// 且样式层给字标留了可收缩 + 省略号（见 shell.css `.side-wordmark`）。
//
// 纯展示组件（函数组件范式）：展示，无内部状态、无副作用。

import { BrandMark } from './BrandMark.tsx';

/** SidebarHeader 组件的入参。 */
export interface SidebarHeaderProps {
  /** 侧栏是否已收成图标条（收起时只留品牌标识）。 */
  rail: boolean;
}

/**
 * 侧栏品牌头：品牌标识 + 字标；图标条态只留标识。
 * @param props 组件入参
 * @returns 品牌头节点
 */
export function SidebarHeader(props: SidebarHeaderProps): ReactElement {
  const { rail } = props;
  return (
    <div className="side-brand">
      <BrandMark />
      {rail ? null : (
        <span className="side-wordmark" title="OmniHarness">
          <span className="side-wordmark-main">
            <span className="side-wordmark-text">Omni</span>
            <span className="side-wordmark-sheen" aria-hidden="true">
              Omni
            </span>
          </span>
          <span className="side-wordmark-tag">HARNESS</span>
        </span>
      )}
      <span className="flex-spacer" aria-hidden="true"></span>
    </div>
  );
}
