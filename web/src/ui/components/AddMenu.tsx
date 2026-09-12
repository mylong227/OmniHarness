// 输入区「+」添加菜单（对标 ChatGPT 的 + 面板）：分组列出
// 添加（文件·目标·计划模式·绘图）→ 插件 → 智能体 → 文件和聊天。
// 打开时按真实 RPC 拉取插件 / 智能体 / 会话模式，搜索框输入即触发 search.all。
//
// 面向对象：结构由 AddMenuModel 拼装（纯数据，可单测）；组件只负责渲染、拉数据、按 id 分派动作。

import { React } from '../deps.js';
import { AddMenuModel } from '../models/AddMenuModel.js';
import type { AgentCatalogEntry, PluginManifest, SearchHit, SessionModes } from '../../types/models.js';
import type { ApiClient } from '../../core/ApiClient.js';

export interface AddMenuProps {
  /** 当前会话 id（目标 / 计划 / 绘图模式按会话持久化）。 */
  threadId: string;
  api: ApiClient;
  /** 打开文件选择器（复用 Composer 现有 FilePicker）。 */
  onAttach: () => void;
  /** 轻提示（加载失败 / 选择智能体等）。 */
  onToast: (msg: string, kind?: 'info' | 'err') => void;
  /** 跳到右侧某面板（点插件时打开「插件」页）。 */
  onOpenTab: (key: string) => void;
  /** 打开文件（搜索命中为文件时）。 */
  onOpenFile: (path: string) => void;
  /** 加载历史会话（搜索命中为聊天时）。 */
  onLoadThread: (id: string) => void;
}

interface AddMenuState {
  open: boolean;
  goal: string;
  planMode: boolean;
  sketchMode: boolean;
  plugins: readonly PluginManifest[];
  pluginsLoading: boolean;
  agents: readonly AgentCatalogEntry[];
  agentsLoading: boolean;
  query: string;
  files: readonly SearchHit[];
  chats: readonly SearchHit[];
  searching: boolean;
}

/** 「+」添加菜单组件。 */
export class AddMenu extends React.Component<AddMenuProps, AddMenuState> {
  private searchTimer = 0;

  constructor(props: AddMenuProps) {
    super(props);
    this.state = {
      open: false,
      goal: '',
      planMode: false,
      sketchMode: false,
      plugins: [],
      pluginsLoading: true,
      agents: [],
      agentsLoading: true,
      query: '',
      files: [],
      chats: [],
      searching: false,
    };
  }

  override componentDidUpdate(_prev: AddMenuProps, prev: AddMenuState): void {
    if (prev.open === this.state.open) return;
    if (this.state.open) {
      window.addEventListener('click', this.close);
      void this.bootstrap();
    } else {
      window.removeEventListener('click', this.close);
    }
  }

  override componentWillUnmount(): void {
    window.removeEventListener('click', this.close);
    if (this.searchTimer) window.clearTimeout(this.searchTimer);
  }

  /** 打开时一次性拉取：会话模式 + 插件 + 智能体。 */
  private async bootstrap(): Promise<void> {
    const { threadId, api } = this.props;
    void api
      .modesGet(threadId)
      .then((m: SessionModes) => this.setState({ goal: m.goal, planMode: m.planMode, sketchMode: m.sketchMode }))
      .catch(() => {});
    this.setState({ pluginsLoading: true });
    api
      .listPlugins()
      .then((plugins) => this.setState({ plugins, pluginsLoading: false }))
      .catch(() => this.setState({ pluginsLoading: false }));
    this.setState({ agentsLoading: true });
    api
      .agentsList()
      .then((r) => this.setState({ agents: r.agents, agentsLoading: false }))
      .catch(() => this.setState({ agentsLoading: false }));
  }

  private readonly close = (): void => {
    this.setState({ open: false });
  };

  private readonly toggle = (e: MouseEvent): void => {
    e.stopPropagation();
    this.setState((prev) => ({ open: !prev.open }));
  };

  private readonly stopBubble = (e: MouseEvent): void => {
    e.stopPropagation();
  };

  /** 切换会话模式（目标 / 计划 / 绘图），调 modes.set 持久化。 */
  private async toggleMode(patch: { goal?: string; planMode?: boolean; sketchMode?: boolean }): Promise<void> {
    const { threadId, api, onToast } = this.props;
    try {
      const next = await api.modesSet(threadId, patch);
      this.setState({ goal: next.goal, planMode: next.planMode, sketchMode: next.sketchMode });
    } catch (e) {
      onToast('模式切换失败：' + (e as Error).message, 'err');
    }
  }

  private readonly onGoal = (): void => {
    const current = this.state.goal;
    const input = window.prompt('设置要持续追求的目标（留空清除）：', current);
    if (input === null) return;
    void this.toggleMode({ goal: input.trim() });
  };

  private readonly onQuery = (value: string): void => {
    this.setState({ query: value });
    if (this.searchTimer) window.clearTimeout(this.searchTimer);
    if (value.trim() === '') {
      this.setState({ files: [], chats: [], searching: false });
      return;
    }
    this.setState({ searching: true });
    this.searchTimer = window.setTimeout(() => {
      this.props.api
        .searchAll(value.trim())
        .then((r) => this.setState({ files: r.files, chats: r.chats, searching: false }))
        .catch(() => this.setState({ searching: false }));
    }, 250);
  };

  /** 按菜单项 id 分派动作。 */
  private readonly onItem = (id: string): void => {
    const { onAttach, onOpenTab, onOpenFile, onLoadThread, onToast } = this.props;
    if (id === 'attach') {
      onAttach();
      this.setState({ open: false });
      return;
    }
    if (id === 'goal') {
      this.onGoal();
      return;
    }
    if (id === 'plan') {
      void this.toggleMode({ planMode: !this.state.planMode });
      return;
    }
    if (id === 'sketch') {
      void this.toggleMode({ sketchMode: !this.state.sketchMode });
      return;
    }
    if (id.startsWith('plugin:')) {
      onOpenTab('plugins');
      this.setState({ open: false });
      return;
    }
    if (id.startsWith('agent:')) {
      const agent = this.state.agents.find((a) => 'agent:' + a.id === id);
      onToast('已选择智能体：' + (agent?.name ?? id) + '（载入会话后生效）');
      this.setState({ open: false });
      return;
    }
    if (id.startsWith('file:')) {
      onOpenFile(id.slice('file:'.length));
      this.setState({ open: false });
      return;
    }
    if (id.startsWith('chat:')) {
      onLoadThread(id.slice('chat:'.length));
      this.setState({ open: false });
      return;
    }
  };

  override render(): ReactElement {
    const { open, query, files, chats, searching } = this.state;
    const model = new AddMenuModel(this.state);
    const sections = model.sections();
    return (
      <div className="addmenu" role="button" aria-haspopup="menu" aria-expanded={open ? 'true' : 'false'} aria-label="添加" onClick={this.toggle}>
        <span className="addmenu-ico">＋</span>
        {open ? (
          <div className="addmenu-pop" onClick={this.stopBubble}>
            <div className="addmenu-search">
              <input
                className="addmenu-input"
                placeholder="搜索文件或聊天…"
                value={query}
                onChange={(e: Event) => this.onQuery((e.target as HTMLInputElement).value)}
              />
            </div>
            <div className="addmenu-scroll">
              {sections.map((section) => (
                <div className="addmenu-sec" key={section.id}>
                  {section.title ? <div className="addmenu-sec-title">{section.title}</div> : null}
                  {section.items.map((item) => (
                    <div
                      key={item.id}
                      className={'addmenu-item' + (item.active ? ' active' : '') + (item.disabled ? ' disabled' : '')}
                      onClick={() => {
                        if (!item.disabled) this.onItem(item.id);
                      }}
                    >
                      <span className="addmenu-item-ico">{item.icon}</span>
                      <span className="addmenu-item-body">
                        <span className="addmenu-item-label">{item.label}</span>
                        {item.hint ? <span className="addmenu-item-hint">{item.hint}</span> : null}
                      </span>
                      {item.active ? <span className="addmenu-item-on">●</span> : null}
                    </div>
                  ))}
                </div>
              ))}
              {searching ? <div className="addmenu-loading">搜索中…</div> : null}
              {files.length === 0 && chats.length === 0 && query.trim() !== '' && !searching ? (
                <div className="addmenu-loading">没有匹配的文件或聊天</div>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>
    );
  }
}
