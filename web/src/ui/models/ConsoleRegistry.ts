// 工作台控制台（设置中心）的导航注册表 —— 左导航的**唯一事实源**。
//
// ## 为什么把设置与功能面板合并到一张表
//
// 2026-10-26 用户要求：「功能列表的全部功能面板和设置面板的全部功能全都重构：如图样子，
// 点击设置按钮进入」。此前是两个互不相干的模态：
//   · 设置（`SettingsModal`，2026-10-28 已删除）：六个分栏，只放"改配置"；
//   · 功能面板（`PanelModal`，2026-10-28 已删除）：十几个只读/半只读面板，只放"看状态"。
// 两者都是「左导航 + 右内容」，却各自维护一份清单与一套几何，用户找一个配置项要先判断
// 它属于哪一类。控制台把它们收进**同一个导航**：分组只表达"这块在管什么"，不再按
// 读/写切分入口。
//
// 分工：
//   · `SettingsModel.SETTINGS_TABS` 仍然回答「设置分栏有哪些、字段归哪一栏」；
//   · `PanelRegistry.PANELS` 仍然回答「功能面板有哪些、叫什么、什么图标」；
//   · 本文件只回答**控制台里怎么分组、按什么顺序出现**，不复制第三份清单。
//     `CONSOLE_ENTRIES` 在模块加载时就从上面两份声明派生，缺 key 会立即抛错（fail-fast）。
//
// 零 React 依赖（只导出纯数据），可直接在 node 下单测。

import type { IconName } from './Icon.ts';
import { PANELS, panelOf } from './PanelRegistry.ts';
import { SETTINGS_TABS, type SettingsTabKey } from './SettingsModel.ts';

/** 控制台导航分组 key。 */
export type ConsoleGroupKey = 'base' | 'agent' | 'data';

/** 一个导航分组。 */
export interface ConsoleGroupDef {
  /** 分组 key。 */
  readonly key: ConsoleGroupKey;
  /** 分组标题（左导航的小标题）。 */
  readonly label: string;
}

/** 分组顺序即左导航从上到下的顺序。 */
export const CONSOLE_GROUPS: readonly ConsoleGroupDef[] = [
  { key: 'base', label: '基础设置' },
  { key: 'agent', label: 'Agent 能力' },
  { key: 'data', label: '数据与统计' },
];

/** 条目类型：设置页（可改配置） / 功能面板（看状态或做管理）。 */
export type ConsoleEntryKind = 'setting' | 'panel';

/** 控制台里的一个导航条目。 */
export interface ConsoleEntry {
  /** 条目 key（设置分栏 key 或面板 key，全表唯一）。 */
  readonly key: string;
  /** 页面标题与导航文案。 */
  readonly label: string;
  /** 页面副标题（标题下方常驻的一句话）。 */
  readonly hint: string;
  /** 左导航图标。 */
  readonly icon: IconName;
  /** 所属分组。 */
  readonly group: ConsoleGroupKey;
  /** 条目类型。 */
  readonly kind: ConsoleEntryKind;
}

/**
 * 基础设置组的顺序。
 *
 * 口径：先"界面怎么用"（常规：语言 / 主题 / 两栏宽度），再"模型怎么接"（模型与厂商 / 运行时），
 * 然后"能做什么"（权限 / 凭据），最后是"本机与键盘"（桌面 / 快捷键）。
 * 凭据（vault）挂在权限之后：两者都是安全边界，但后者是规则、前者是密钥。
 */
const BASE_SETTINGS_ORDER: readonly (SettingsTabKey | 'vault')[] = [
  'general',
  'model',
  'runtime',
  'permission',
  'vault',
  'desktop',
  'shortcuts',
];

/** Agent 能力组：按"上下文 → 扩展 → 执行"的顺序。 */
const AGENT_PANEL_ORDER: readonly string[] = [
  'profiles',
  'plugins',
  'skills',
  'memory',
  'graph',
  'automations',
  'tools',
];

/** 数据与统计组：先看汇总，再看流水与审计，最后是单点钻取。 */
const DATA_PANEL_ORDER: readonly string[] = [
  'metrics',
  'activity',
  'changes',
  'governance',
  'rollback',
  'audit',
  'diagnostics',
  'trace',
  'detail',
];

/** 设置分栏 key 集合（判定某个 key 是不是设置页）。 */
const SETTING_KEYS: ReadonlySet<string> = new Set(SETTINGS_TABS.map((tab) => tab.key));

/** 从设置分栏声明派生一个条目；声明缺失时直接抛错（不静默丢一页）。 */
function settingEntry(key: SettingsTabKey, group: ConsoleGroupKey): ConsoleEntry {
  const tab = SETTINGS_TABS.find((item) => item.key === key);
  if (tab === undefined) throw new Error(`控制台注册表：SETTINGS_TABS 缺少分栏 ${key}`);
  return { key: tab.key, label: tab.label, hint: tab.hint, icon: tab.icon, group, kind: 'setting' };
}

/** 从面板声明派生一个条目；声明缺失时直接抛错（不静默丢一页）。 */
function panelEntry(key: string, group: ConsoleGroupKey): ConsoleEntry {
  const panel = panelOf(key);
  if (panel === undefined) throw new Error(`控制台注册表：PANELS 缺少面板 ${key}`);
  return {
    key: panel.key,
    label: panel.label,
    hint: panel.description,
    icon: panel.icon,
    group,
    kind: 'panel',
  };
}

/** 全部条目（顺序 = 分组顺序 + 组内顺序）。 */
export const CONSOLE_ENTRIES: readonly ConsoleEntry[] = [
  ...BASE_SETTINGS_ORDER.map((key) =>
    key === 'vault' ? panelEntry('vault', 'base') : settingEntry(key, 'base'),
  ),
  ...AGENT_PANEL_ORDER.map((key) => panelEntry(key, 'agent')),
  ...DATA_PANEL_ORDER.map((key) => panelEntry(key, 'data')),
];

/** 默认落点：点设置按钮时进入「常规」（与截图里的默认页一致）。 */
export const DEFAULT_CONSOLE_ENTRY = 'general';

/** 不在控制台里出现的面板：文件是右栏内容视图（不是页面），权限已并入设置页。 */
export const CONSOLE_EXCLUDED_PANELS: readonly string[] = ['file', 'permission'];

/**
 * 取条目；未知 key 回退「常规」。
 * @param key 条目 key
 * @returns 条目
 */
export function consoleEntryOf(key: string): ConsoleEntry {
  return CONSOLE_ENTRIES.find((entry) => entry.key === key) ?? CONSOLE_ENTRIES[0]!;
}

/**
 * 判断一个 key 是否设置分栏。
 * @param key 条目 key
 * @returns 是设置页时为 true
 */
export function isSettingKey(key: string): key is SettingsTabKey {
  return SETTING_KEYS.has(key);
}

/**
 * 取某个分组下的条目。
 * @param group 分组 key
 * @returns 条目数组
 */
export function consoleEntriesOfGroup(group: ConsoleGroupKey): readonly ConsoleEntry[] {
  return CONSOLE_ENTRIES.filter((entry) => entry.group === group);
}

/**
 * 校验注册表覆盖了全部面板（供判据使用；运行期不调用）。
 * @returns 未进入控制台且未被显式排除的面板 key
 */
export function missingPanels(): string[] {
  return PANELS.filter(
    (panel) =>
      !CONSOLE_ENTRIES.some((entry) => entry.key === panel.key) &&
      !CONSOLE_EXCLUDED_PANELS.includes(panel.key),
  ).map((panel) => panel.key);
}
