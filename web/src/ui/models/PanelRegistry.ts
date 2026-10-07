// 右侧面板注册表：12 个面板的**唯一事实源**（key / 标签 / 图标）。
//
// ## 演进（2026-10-07 壳层重构）
//
// 面板清单原先有三处消费者：`RightPanel` 的标签条、`NavRail` 的导航竖条（`rail: true` 子集）、
// 以及后来的「更多面板」菜单。壳层重构后前两者不复存在——右栏改为**代码查看器**（文件标签 +
// 路径栏），12 个功能面板全部收进 `PanelPicker`（「全部面板」菜单）这一个入口；本注册表成为
// 菜单与 `panelOf()` 查询的唯一事实源。`rail` 布尔位随 NavRail 一并移除（死数据不保留）。
//
// 零 React 依赖（只导出纯数据），可直接在 node 下单测；图标名来自 `models/Icon.ts` 的 `IconName`。

import type { IconName } from './Icon.js';

/** 右栏面板条目。 */
export interface PanelEntry {
  /** 面板 key（与 `activePane` / 路由 `pane` 同值）。 */
  readonly key: string;
  /** 面板文案（菜单与标签用，尽量短）。 */
  readonly label: string;
  /** 菜单用的线性图标名。 */
  readonly icon: IconName;
}

/**
 * 12 个面板，顺序即**「全部面板」菜单的渲染顺序**。
 *
 * 顺序口径（按"当前在做什么"串起来）：**工作 → 观察 → 编排 → 排障 → 配置**：
 *   工具/变更（手上这摊活）· 文件（内容）· 指标（运行观察）· 编排（多步流程）·
 *   记忆/配置集（上下文与预设）· 治理/回滚（审计与撤销）· 钻取（单事件深挖）· 设置/插件（改配置）。
 * 若哪天菜单要另排顺序，请新增显式的 `order` 字段，而不是再抄一份清单。
 */
export const PANELS: readonly PanelEntry[] = [
  { key: 'tools', label: '工具', icon: 'wrench' },
  { key: 'changes', label: '变更', icon: 'pencil' },
  { key: 'file', label: '文件', icon: 'file' },
  { key: 'metrics', label: '指标', icon: 'chart' },
  { key: 'graph', label: '编排', icon: 'columns' },
  { key: 'memory', label: '记忆', icon: 'brain' },
  { key: 'profiles', label: '配置集', icon: 'sliders' },
  { key: 'governance', label: '治理', icon: 'shield' },
  { key: 'rollback', label: '回滚', icon: 'rewind' },
  { key: 'detail', label: '钻取', icon: 'search' },
  { key: 'settings', label: '设置', icon: 'gear' },
  { key: 'plugins', label: '插件', icon: 'package' },
];

/**
 * 取面板条目（未知 key 返回 undefined；调用方自行决定回退）。
 * @param key 面板 key
 * @returns 条目或 undefined
 */
export function panelOf(key: string): PanelEntry | undefined {
  return PANELS.find((p) => p.key === key);
}
