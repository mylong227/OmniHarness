// 「＋」菜单打开时的取数（从 AddMenu 抽出）。
//
// 一次打开取三份数据：会话模式（目标/计划/绘图）、插件清单、智能体清单。三者的形状校验
// 逻辑留在组件侧的使用点（插件不是数组 ⇒ 空列表，见原注释），这里只负责取与装。

import * as React from 'react';
import type { AgentCatalogEntry, PluginManifest, SessionModes } from '../../types/models.ts';
import type { ApiClient } from '../../core/ApiClient.ts';

/** 取数依赖。 */
export interface AddMenuDataOptions {
  /** 是否展开。 */
  readonly open: boolean;
  /** RPC 客户端。 */
  readonly api: ApiClient;
  /** 当前会话 id（空串 = 无会话，不发 `modes.get`）。 */
  readonly threadId: string;
}

/** 取数结果。 */
export interface AddMenuData {
  /** 持续目标。 */
  readonly goal: string;
  /** 计划模式。 */
  readonly planMode: boolean;
  /** 绘图模式。 */
  readonly sketchMode: boolean;
  /** 已安装插件。 */
  readonly plugins: readonly PluginManifest[];
  /** 插件是否加载中。 */
  readonly pluginsLoading: boolean;
  /** 可用智能体。 */
  readonly agents: readonly AgentCatalogEntry[];
  /** 智能体是否加载中。 */
  readonly agentsLoading: boolean;
  /** 覆盖会话模式（供组件内的乐观更新使用）。 */
  readonly patchModes: (patch: Partial<SessionModes>) => void;
}

/**
 * 打开时拉取模式 / 插件 / 智能体。
 * @param options 展开态、api 与会话 id
 * @returns 取到的数据与模式覆盖入口
 */
export function useAddMenuData(options: AddMenuDataOptions): AddMenuData {
  const { open, api, threadId } = options;
  const [goal, setGoal] = React.useState<string>('');
  const [planMode, setPlanMode] = React.useState<boolean>(false);
  const [sketchMode, setSketchMode] = React.useState<boolean>(false);
  const [plugins, setPlugins] = React.useState<readonly PluginManifest[]>([]);
  const [pluginsLoading, setPluginsLoading] = React.useState<boolean>(true);
  const [agents, setAgents] = React.useState<readonly AgentCatalogEntry[]>([]);
  const [agentsLoading, setAgentsLoading] = React.useState<boolean>(true);

  React.useEffect(() => {
    if (!open) return undefined;
    // 没有会话时不发 `modes.get`：模式按会话持久化，此时服务端必然拒（省掉一次注定失败的 RPC）。
    if (threadId !== '') {
      void api
        .modesGet(threadId)
        .then((m: SessionModes) => {
          setGoal(m.goal);
          setPlanMode(m.planMode);
          setSketchMode(m.sketchMode);
        })
        .catch(() => {});
    }
    setPluginsLoading(true);
    api
      .listPlugins()
      .then((list) => {
        // 防御：响应形状不符（旧版服务端没有该方法 ⇒ 回落成 `{}`）时给空列表，而不是把
        // `undefined` 塞进 state——那会让 `sections()` 在 `.length`/`.map` 上抛错，React 直接把
        // 整块输入区卸载掉（2026-09-27 在 stub 页实测：点＋后 `.addmenu` 整个消失）。
        setPlugins(Array.isArray(list) ? list : []);
        setPluginsLoading(false);
      })
      .catch(() => setPluginsLoading(false));
    setAgentsLoading(true);
    api
      .agentsList()
      .then((r) => {
        setAgents(Array.isArray(r.agents) ? r.agents : []);
        setAgentsLoading(false);
      })
      .catch(() => setAgentsLoading(false));
    return undefined;
  }, [open, api, threadId]);

  const patchModes = (patch: Partial<SessionModes>): void => {
    if (patch.goal !== undefined) setGoal(patch.goal);
    if (patch.planMode !== undefined) setPlanMode(patch.planMode);
    if (patch.sketchMode !== undefined) setSketchMode(patch.sketchMode);
  };

  return {
    goal,
    planMode,
    sketchMode,
    plugins,
    pluginsLoading,
    agents,
    agentsLoading,
    patchModes,
  };
}
