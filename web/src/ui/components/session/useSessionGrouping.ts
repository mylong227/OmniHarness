// 会话分组的展开/折叠与「显示全部」上限（从 SessionPanel 抽出）。
//
// 两个稀疏 map 的键由 SessionViews 的分组逻辑决定（项目组用归一化路径、时间组用 `time:` 前缀），
// 面板不需要知道键的构造规则，只按 key 存开关与上限。

import * as React from 'react';

/** 分组折叠 / 分页上限状态与动作。 */
export interface SessionGrouping {
  /** 分组折叠开关（缺省由 SessionViews 决定：当前项目组展开、其余折叠）。 */
  readonly collapsed: Record<string, boolean>;
  /** 各组的「显示全部」上限（缺省为 SessionViews.PAGE）。 */
  readonly limits: Record<string, number>;
  /** 折叠 / 展开某组。 */
  readonly onToggleGroup: (key: string, isCollapsed: boolean) => void;
  /** 把某组的上限抬到全部条数。 */
  readonly onShowAll: (key: string, total: number) => void;
}

/**
 * 分组折叠 / 分页上限状态。
 * @returns 分组状态与动作
 */
export function useSessionGrouping(): SessionGrouping {
  const [collapsed, setCollapsed] = React.useState<Record<string, boolean>>({});
  const [limits, setLimits] = React.useState<Record<string, number>>({});

  /** 折叠 / 展开某组（存的是「翻转后的折叠态」，与 SessionViews 的读法一致）。 */
  const onToggleGroup = (key: string, isCollapsed: boolean): void => {
    setCollapsed((prev) => ({ ...prev, [key]: !isCollapsed }));
  };

  /** 把某组的上限抬到全部条数。 */
  const onShowAll = (key: string, total: number): void => {
    setLimits((prev) => ({ ...prev, [key]: total }));
  };

  return { collapsed, limits, onToggleGroup, onShowAll };
}
