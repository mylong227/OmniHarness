// 功能面板注册表：每个面板的**唯一事实源**（key / 标签 / 图标 / 页面说明）。
//
// ## 演进（2026-10-07 壳层重构）
//
// 面板清单原先有三处消费者：`RightPanel` 的标签条、`NavRail` 的导航竖条（`rail: true` 子集）、
// 以及后来的「更多面板」菜单。壳层重构后前两者不复存在——右栏改为**代码查看器**（文件标签 +
// 路径栏），功能面板收进 `PanelPicker` 入口；2026-10-26 起该入口打开「工作台控制台」，
// 面板与设置共用同一份左导航（见 `ConsoleRegistry.ts`）。本注册表仍是面板 key / 标签 / 图标的
// 唯一事实源，`rail` 布尔位随 NavRail 一并移除（死数据不保留）。
//
// 零 React 依赖（只导出纯数据），可直接在 node 下单测；图标名来自 `models/Icon.ts` 的 `IconName`。

import type { IconName } from './Icon.ts';

/** 功能面板条目。 */
export interface PanelEntry {
  /** 面板 key（与 `activePane` / 路由 `pane` 同值）。 */
  readonly key: string;
  /** 面板文案（菜单与标签用，尽量短）。 */
  readonly label: string;
  /** 菜单用的线性图标名。 */
  readonly icon: IconName;
  /**
   * 控制台页面的一句话说明（页面标题下方常驻）。
   *
   * 与 `PanelScope` 的 hint 分工不同：那条解释「数据跟着什么走」，这条解释「这里能做什么」。
   */
  readonly description: string;
}

/**
 * 功能面板清单（顺序即注册表声明顺序；控制台分组另见 `ConsoleRegistry.ts`）。
 *
 * 顺序口径（按"当前在做什么"串起来）：**工作 → 观察 → 编排 → 排障 → 配置**：
 *   工具/变更（手上这摊活）· 文件（内容）· 指标（运行观察）· 编排（多步流程）·
 *   记忆/配置集（上下文与预设）· 治理/回滚（审计与撤销）· 钻取（单事件深挖）· 插件（扩展）。
 * 控制台里的**分组与组内顺序**由 `ConsoleRegistry.ts` 显式声明，不在本表里表达。
 *
 * ⚠️ **设置不在这里**（2026-10-17 移除）。它原先与这些面板并列，但语义不同：
 * 这些面板都是"看某个东西的状态"，而设置是"改全局配置"。
 * 2026-10-26 起设置与面板在**界面入口**上合并为工作台控制台
 * （`components/console/ConsoleModal.tsx`，导航见 `ConsoleRegistry.ts`），但本注册表只描述面板；
 * 设置分栏仍在 `SettingsModel.SETTINGS_TABS`。要加回面板列表前先读控制台组件的头注释。
 */
export const PANELS: readonly PanelEntry[] = [
  { key: 'activity', label: '活动', icon: 'chart', description: '本会话的审批、变更与最近事件汇总' },
  { key: 'skills', label: '技能', icon: 'sparkle', description: '可复用技能目录，按名称、描述与标签检索' },
  { key: 'automations', label: '自动化', icon: 'refresh', description: '定时与事件触发的自动化任务' },
  { key: 'tools', label: '工具', icon: 'wrench', description: '本次会话触发的工具调用与结果' },
  { key: 'changes', label: '变更', icon: 'pencil', description: '工作区文件变更与逐块暂存 / 还原' },
  { key: 'file', label: '文件', icon: 'file', description: '工作区文件的只读预览' },
  { key: 'metrics', label: '指标', icon: 'chart', description: '会话、事件、工具调用计数与 Token 消耗' },
  { key: 'graph', label: '编排', icon: 'columns', description: '多步编排图、运行进度与续跑' },
  { key: 'memory', label: '记忆', icon: 'brain', description: '跨会话长期记忆的检索与维护' },
  { key: 'profiles', label: '配置集', icon: 'sliders', description: '配置集与 Bundle 的保存、应用、打包' },
  { key: 'governance', label: '治理', icon: 'shield', description: '晋升台账与逐行独立复核' },
  { key: 'rollback', label: '回滚', icon: 'rewind', description: '会话检查点与回滚' },
  { key: 'detail', label: '钻取', icon: 'search', description: '单条事件的原始载荷与钻取' },
  { key: 'plugins', label: '插件', icon: 'package', description: '已安装 / 可获取插件的管理' },
  { key: 'diagnostics', label: '诊断', icon: 'ruler', description: 'daemon 运行态与环境体检报告' },
  // Web 交付（2026-10-11）：审计事件与只读 trace 自省——两条都是**已有 RPC 缺入口**。
  { key: 'audit', label: '审计', icon: 'shield-alert', description: '审计事件哈希链（只追加）' },
  { key: 'trace', label: 'Trace', icon: 'search', description: '本会话的只读 trace 自省' },
  { key: 'permission', label: '权限', icon: 'shield', description: '参数级权限规则编辑器' },
  { key: 'vault', label: '凭据', icon: 'archive', description: '凭据保险库（只列名字，写后不回读）' },
];

/**
 * 取面板条目（未知 key 返回 undefined；调用方自行决定回退）。
 * @param key 面板 key
 * @returns 条目或 undefined
 */
export function panelOf(key: string): PanelEntry | undefined {
  return PANELS.find((p) => p.key === key);
}
