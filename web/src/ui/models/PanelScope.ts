/**
 * 面板的「数据范围」元数据：每个右栏面板的数据到底跟着什么走。
 *
 * 为什么单独成表（2026-10-19）：用户在「全部面板」里翻了 16 个页面，最困惑的是
 * **这个页面的数字是哪个会话/哪个工作区的**。之前每个面板各自在 JSDoc 里解释，
 * UI 上却完全看不出来。这里做成唯一事实源，由面板模态顶栏渲染成一枚
 * 小徽标（`会话 / 工作区 / 全局 / 服务端`）+ 一行 hover 说明。
 *
 * 与 `PanelRegistry` 分开：注册表回答「有哪些面板、叫什么、什么图标」，
 * 本表回答「数据范围与实时性」，两者职责不同，改动频率也不同。
 */

/** 面板数据范围。 */
export type PanelScope = 'session' | 'workspace' | 'global' | 'server';

/** 单个面板的范围元数据。 */
export interface PanelScopeMeta {
  /** 数据范围（决定徽标文案与着色）。 */
  readonly scope: PanelScope;
  /** 一行说明（路径栏 title；不占常驻版面）。 */
  readonly hint: string;
}

/** 面板 key → 范围元数据（与 `PANELS` 的 key 一一对应）。 */
export const PANEL_SCOPE: Readonly<Record<string, PanelScopeMeta>> = {
  tools: { scope: 'session', hint: '本次会话已触发的工具调用；随回合实时追加。' },
  changes: { scope: 'workspace', hint: '当前工作区的文件变更（非 git 工作区按本会话事件聚合）。' },
  file: { scope: 'workspace', hint: '工作区文件的只读预览。' },
  metrics: { scope: 'session', hint: '本会话的 token 消耗 + 进程级指标；随回合实时刷新。' },
  graph: { scope: 'workspace', hint: '工作区的编排图与运行态；运行进度实时推送。' },
  memory: { scope: 'global', hint: '长期记忆（跨会话共享；变更事件会实时刷新）。' },
  profiles: { scope: 'global', hint: '配置集与插件组合（全局；应用/保存后刷新）。' },
  governance: { scope: 'workspace', hint: '工作区 .omniharness/evolution 的晋升台账（逐行独立复核）。' },
  rollback: { scope: 'session', hint: '本会话的检查点与回滚；切会话自动重载。' },
  detail: { scope: 'session', hint: '从本会话事件流中选中一条事件的详情。' },
  plugins: { scope: 'global', hint: '已安装 / 可获取插件（全局；安装后刷新）。' },
  diagnostics: { scope: 'server', hint: '服务端进程与运行环境诊断（非会话数据）。' },
  audit: { scope: 'global', hint: '审计事件哈希链（全局、只追加）。' },
  trace: { scope: 'session', hint: '本会话的只读 trace（按事件序列读取）。' },
  permission: { scope: 'global', hint: '参数级权限规则（写进 omniharness.json，全局生效）。' },
  vault: { scope: 'global', hint: '凭据保险库（只列名字，写后不回读）。' },
};

/**
 * 取面板范围元数据；未知 key 回退「全局」（fail-open 到中性展示，不抛错）。
 * @param key 面板 key
 * @returns 范围元数据
 */
export function panelScopeOf(key: string): PanelScopeMeta {
  return PANEL_SCOPE[key] ?? { scope: 'global', hint: '全局数据。' };
}
