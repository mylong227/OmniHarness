// 输入区「+」添加菜单的展示模型：把菜单结构拼成纯数据，组件层只负责渲染与按 id 分派动作。
// 零 React 依赖，node 环境可直接单测。

import type { AgentCatalogEntry, PluginManifest, SearchHit } from '../../types/models.js';

/** 菜单项（纯描述，不含回调——回调由组件按 id 分派，便于单测断言结构）。 */
export interface AddMenuItem {
  /** 稳定 id（组件据此分派动作；`loading` 类项不可点）。 */
  readonly id: string;
  /** 前置图标（emoji，与仓库既有风格一致）。 */
  readonly icon: string;
  /** 主文案。 */
  readonly label: string;
  /** 次要说明（可为空）。 */
  readonly hint: string;
  /** 是否处于开启态（计划模式 / 绘图模式用）。 */
  readonly active: boolean;
  /** 是否禁用（加载中 / 空结果占位）。 */
  readonly disabled: boolean;
}

/** 菜单分组。 */
export interface AddMenuSection {
  /** 分组 id。 */
  readonly id: string;
  /** 分组标题（空串表示不渲染标题）。 */
  readonly title: string;
  /** 分组内容项。 */
  readonly items: readonly AddMenuItem[];
}

/** 菜单数据源（全部来自已加载的真实后端数据）。 */
export interface AddMenuState {
  /** 当前目标文本（空串 = 未设置）。 */
  readonly goal: string;
  /** 计划模式是否开启。 */
  readonly planMode: boolean;
  /** 绘图模式是否开启。 */
  readonly sketchMode: boolean;
  /** 已安装插件。 */
  readonly plugins: readonly PluginManifest[];
  /** 插件是否仍在加载。 */
  readonly pluginsLoading: boolean;
  /** 可选智能体。 */
  readonly agents: readonly AgentCatalogEntry[];
  /** 智能体是否仍在加载。 */
  readonly agentsLoading: boolean;
  /** 「文件和聊天」搜索关键词。 */
  readonly query: string;
  /** 文件命中。 */
  readonly files: readonly SearchHit[];
  /** 聊天命中。 */
  readonly chats: readonly SearchHit[];
}

/**
 * 添加菜单模型。
 *
 * 结构照着参考实现（ChatGPT 的「+」面板）来：**添加**（文件、目标、计划模式、绘图）→
 * **插件** → **智能体** → **文件和聊天**。刻意保留「加载中」占位而不是等数据齐了再渲染整块——
 * 面板瞬间弹出却空着，用户会以为功能坏了；占位行能立刻说明「东西在来」。
 */
export class AddMenuModel {
  private readonly state: AddMenuState;

  /**
   * @param state 菜单数据源
   */
  public constructor(state: AddMenuState) {
    this.state = state;
  }

  /** 全部分组（顺序即展示顺序）。 */
  public sections(): AddMenuSection[] {
    return [this.addSection(), this.pluginSection(), this.agentSection(), this.searchSection()];
  }

  /** 「添加」分组：文件与文件夹 / 目标 / 计划模式 / 绘图。 */
  private addSection(): AddMenuSection {
    return {
      id: 'add',
      title: '添加',
      items: [
        this.item('attach', '📎', '文件和文件夹', '', false),
        this.itemFromGoal(),
        this.toggle('plan', '💡', '计划模式', '开启计划模式', this.state.planMode),
        this.toggle('sketch', '📐', '绘图', '绘制草图', this.state.sketchMode),
      ],
    };
  }

  /** 目标项：已设置时把目标文本直接显示出来，用户一眼知道当前背着什么目标。 */
  private itemFromGoal(): AddMenuItem {
    const goal = this.state.goal.trim();
    return {
      id: 'goal',
      icon: '🎯',
      label: '目标',
      hint: goal === '' ? '设置要持续追求的目标' : goal,
      active: goal !== '',
      disabled: false,
    };
  }

  /** 「插件」分组。 */
  private pluginSection(): AddMenuSection {
    if (this.state.pluginsLoading) {
      return { id: 'plugins', title: '插件', items: [this.placeholder('plugins-loading', '正在加载插件…')] };
    }
    if (this.state.plugins.length === 0) {
      return { id: 'plugins', title: '插件', items: [this.placeholder('plugins-empty', '暂无已安装插件')] };
    }
    return {
      id: 'plugins',
      title: '插件',
      items: this.state.plugins.map((plugin) => ({
        id: 'plugin:' + plugin.name,
        icon: plugin.loaded === true ? '🧩' : '📦',
        label: plugin.name,
        hint: plugin.description ?? `v${plugin.version}`,
        active: plugin.loaded === true,
        disabled: false,
      })),
    };
  }

  /** 「智能体」分组（内置角色 / 编排图 / 插件三类混排，靠 hint 区分来源）。 */
  private agentSection(): AddMenuSection {
    if (this.state.agentsLoading) {
      return { id: 'agents', title: '智能体', items: [this.placeholder('agents-loading', '正在加载智能体…')] };
    }
    if (this.state.agents.length === 0) {
      return { id: 'agents', title: '智能体', items: [this.placeholder('agents-empty', '暂无可用智能体')] };
    }
    return {
      id: 'agents',
      title: '智能体',
      items: this.state.agents.map((agent) => ({
        id: 'agent:' + agent.id,
        icon: this.agentIcon(agent.kind),
        label: agent.name,
        hint: agent.description,
        active: false,
        disabled: false,
      })),
    };
  }

  /** 「文件和聊天」分组：有查询词才检索；空查询给出引导文案。 */
  private searchSection(): AddMenuSection {
    if (this.state.query.trim() === '') {
      return {
        id: 'search',
        title: '文件和聊天',
        items: [this.placeholder('search-hint', '输入内容以搜索文件或聊天')],
      };
    }
    const hits = [...this.state.files, ...this.state.chats];
    if (hits.length === 0) {
      return { id: 'search', title: '文件和聊天', items: [this.placeholder('search-empty', '没有匹配的文件或聊天')] };
    }
    return {
      id: 'search',
      title: '文件和聊天',
      items: hits.map((hit) => ({
        id: (hit.kind === 'file' ? 'file:' : 'chat:') + hit.id,
        icon: hit.kind === 'file' ? '📄' : '💬',
        label: hit.label,
        hint: hit.hint,
        active: false,
        disabled: false,
      })),
    };
  }

  /** 构造普通菜单项。 */
  private item(id: string, icon: string, label: string, hint: string, active: boolean): AddMenuItem {
    return { id, icon, label, hint, active, disabled: false };
  }

  /** 构造开关类菜单项（右侧显示开 / 关）。 */
  private toggle(id: string, icon: string, label: string, hint: string, on: boolean): AddMenuItem {
    return {
      id,
      icon,
      label,
      hint: on ? hint + '（已开启）' : hint,
      active: on,
      disabled: false,
    };
  }

  /** 构造占位项（不可点）。 */
  private placeholder(id: string, label: string): AddMenuItem {
    return { id, icon: '…', label, hint: '', active: false, disabled: true };
  }

  /** 智能体来源图标。 */
  private agentIcon(kind: AgentCatalogEntry['kind']): string {
    if (kind === 'graph') return '🕸';
    if (kind === 'plugin') return '🧩';
    return '🤖';
  }
}
