// 输入区「+」添加菜单（对标 ChatGPT 的 + 面板）：分组列出
// 添加（文件·目标·计划模式·绘图）→ 插件 → 智能体 → 文件和聊天。
// 打开时按真实 RPC 拉取插件 / 智能体 / 会话模式，搜索框输入即触发 search.all。
//
// 面向对象：结构由 AddMenuModel 拼装（纯数据，可单测）；组件只负责渲染、拉数据、按 id 分派动作。
//
// 函数组件范式：12 个交互字段各一个 useState（打开态 / 三种模式 / 两类目录及其加载态 / 搜索四项）；
// 「打开即拉数 + 挂外部点击监听」由依赖 open 的单个 effect 承接，搜索防抖定时器由 useRef 持有，
// 随 effect 清理（H3 对称）。

import { React } from '../deps.js';
import { useApp } from '../context.js';
import { AddMenuModel, type AddMenuSection } from '../models/AddMenuModel.js';
import type { AgentCatalogEntry, PluginManifest, SearchHit, SessionModes } from '../../types/models.js';
import type { ApiClient } from '../../core/ApiClient.js';

/** 搜索防抖时长（ms）。 */
const SEARCH_DEBOUNCE_MS = 250;

/** AddMenu 组件的入参。 */
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

/**
 * 渲染一个菜单分组（含标题与逐项按钮）。纯展示，无状态。
 * @param section 分组数据
 * @param onItem 点击某项（id）时回调
 * @returns 分组节点
 */
function renderSection(section: AddMenuSection, onItem: (id: string) => void): ReactElement {
  return (
    <div className="addmenu-sec" key={section.id}>
      {section.title ? <div className="addmenu-sec-title">{section.title}</div> : null}
      {section.items.map((item) => (
        <div
          key={item.id}
          className={'addmenu-item' + (item.active ? ' active' : '') + (item.disabled ? ' disabled' : '')}
          onClick={() => {
            if (!item.disabled) onItem(item.id);
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
  );
}

/**
 * 「+」添加菜单：分组列出添加入口、插件、智能体与文件/聊天搜索。
 * @param props 组件入参
 * @returns 菜单节点
 */
export function AddMenu(props: AddMenuProps): ReactElement {
  const { threadId, api, onAttach, onToast, onOpenTab, onOpenFile, onLoadThread } = props;
  const { dialog } = useApp();
  const [open, setOpen] = React.useState<boolean>(false);
  const [goal, setGoal] = React.useState<string>('');
  const [planMode, setPlanMode] = React.useState<boolean>(false);
  const [sketchMode, setSketchMode] = React.useState<boolean>(false);
  const [plugins, setPlugins] = React.useState<readonly PluginManifest[]>([]);
  const [pluginsLoading, setPluginsLoading] = React.useState<boolean>(true);
  const [agents, setAgents] = React.useState<readonly AgentCatalogEntry[]>([]);
  const [agentsLoading, setAgentsLoading] = React.useState<boolean>(true);
  const [query, setQuery] = React.useState<string>('');
  const [files, setFiles] = React.useState<readonly SearchHit[]>([]);
  const [chats, setChats] = React.useState<readonly SearchHit[]>([]);
  const [searching, setSearching] = React.useState<boolean>(false);
  /** 搜索防抖定时器。 */
  const searchTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  // 打开时：挂外部点击监听，并一次性拉取会话模式 + 插件 + 智能体；收起 / 卸载即摘监听、清防抖。
  React.useEffect(() => {
    if (!open) return undefined;
    const close = (): void => setOpen(false);
    window.addEventListener('click', close);
    void api
      .modesGet(threadId)
      .then((m: SessionModes) => {
        setGoal(m.goal);
        setPlanMode(m.planMode);
        setSketchMode(m.sketchMode);
      })
      .catch(() => {});
    setPluginsLoading(true);
    api
      .listPlugins()
      .then((list) => {
        setPlugins(list);
        setPluginsLoading(false);
      })
      .catch(() => setPluginsLoading(false));
    setAgentsLoading(true);
    api
      .agentsList()
      .then((r) => {
        setAgents(r.agents);
        setAgentsLoading(false);
      })
      .catch(() => setAgentsLoading(false));
    return () => {
      window.removeEventListener('click', close);
      if (searchTimer.current !== null) clearTimeout(searchTimer.current);
    };
  }, [open, api, threadId]);

  /** 触发按钮：阻断冒泡后切换展开态（阻断后不会被刚挂的外部点击监听立即关掉）。 */
  const toggle = (e: MouseEvent): void => {
    e.stopPropagation();
    setOpen((prev) => !prev);
  };

  /**
   * 切换会话模式（目标 / 计划 / 绘图），调 modes.set 持久化。
   * @param patch 模式补丁
   * @returns 无
   */
  const toggleMode = async (patch: { goal?: string; planMode?: boolean; sketchMode?: boolean }): Promise<void> => {
    try {
      const next = await api.modesSet(threadId, patch);
      setGoal(next.goal);
      setPlanMode(next.planMode);
      setSketchMode(next.sketchMode);
    } catch (e) {
      onToast('模式切换失败：' + (e as Error).message, 'err');
    }
  };

  /** 编辑持续目标（经应用内对话框输入）。 @returns 无 */
  const onGoal = async (): Promise<void> => {
    const input = await dialog.prompt('设置要持续追求的目标（留空清除）：', goal, {
      title: '持续目标',
      confirmLabel: '保存',
      placeholder: '例如：把召回率提到 60%',
    });
    if (input === null) return;
    void toggleMode({ goal: input.trim() });
  };

  /**
   * 搜索框输入：更新关键字并防抖触发 search.all。
   * @param value 输入值
   * @returns 无
   */
  const onQuery = (value: string): void => {
    setQuery(value);
    if (searchTimer.current !== null) clearTimeout(searchTimer.current);
    if (value.trim() === '') {
      setFiles([]);
      setChats([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    searchTimer.current = setTimeout(() => {
      api
        .searchAll(value.trim())
        .then((r) => {
          setFiles(r.files);
          setChats(r.chats);
          setSearching(false);
        })
        .catch(() => setSearching(false));
    }, SEARCH_DEBOUNCE_MS);
  };

  /**
   * 按菜单项 id 分派动作。
   * @param id 菜单项 id
   * @returns 无
   */
  const onItem = (id: string): void => {
    if (id === 'attach') {
      onAttach();
      setOpen(false);
      return;
    }
    if (id === 'goal') {
      void onGoal();
      return;
    }
    if (id === 'plan') {
      void toggleMode({ planMode: !planMode });
      return;
    }
    if (id === 'sketch') {
      void toggleMode({ sketchMode: !sketchMode });
      return;
    }
    if (id.startsWith('plugin:')) {
      onOpenTab('plugins');
      setOpen(false);
      return;
    }
    if (id.startsWith('agent:')) {
      const agent = agents.find((a) => 'agent:' + a.id === id);
      onToast('已选择智能体：' + (agent?.name ?? id) + '（载入会话后生效）');
      setOpen(false);
      return;
    }
    if (id.startsWith('file:')) {
      onOpenFile(id.slice('file:'.length));
      setOpen(false);
      return;
    }
    if (id.startsWith('chat:')) {
      onLoadThread(id.slice('chat:'.length));
      setOpen(false);
    }
  };

  const model = new AddMenuModel({
    goal,
    planMode,
    sketchMode,
    plugins,
    pluginsLoading,
    agents,
    agentsLoading,
    query,
    files,
    chats,
  });
  const sections = model.sections();
  return (
    <div
      className="addmenu"
      role="button"
      aria-haspopup="menu"
      aria-expanded={open ? 'true' : 'false'}
      aria-label="添加"
      onClick={toggle}
    >
      <span className="addmenu-ico">＋</span>
      {open ? (
        <div className="addmenu-pop" onClick={(e: MouseEvent) => e.stopPropagation()}>
          <div className="addmenu-search">
            <input
              className="addmenu-input"
              placeholder="搜索文件或聊天…"
              value={query}
              onChange={(e: Event) => onQuery((e.target as HTMLInputElement).value)}
            />
          </div>
          <div className="addmenu-scroll">
            {sections.map((section) => renderSection(section, onItem))}
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
