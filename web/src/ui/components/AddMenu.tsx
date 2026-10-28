// 输入区「+」添加菜单：分组列出
// 添加（文件·目标·计划模式·绘图）→ 插件 → 智能体 → 文件和聊天。
// 打开时按真实 RPC 拉取插件 / 智能体 / 会话模式，搜索框输入即触发 search.all。
//
// 面向对象：结构由 AddMenuModel 拼装（纯数据，可单测）；组件只负责渲染、拉数据、按 id 分派动作。
//
// 函数组件范式：12 个交互字段各一个 useState（打开态 / 三种模式 / 两类目录及其加载态 / 搜索四项）；
// 「打开即拉数 + 挂外部点击监听」由依赖 open 的单个 effect 承接，搜索防抖定时器由 useRef 持有，
// 随 effect 清理（H3 对称）。

import * as React from 'react';
import { icon } from '../models/Icon.ts';
import { useApp } from '../context.ts';
import { AddMenuModel, type AddMenuSection } from '../models/AddMenuModel.ts';
import { PendingModes } from '../models/PendingModes.ts';
import { claimPopover, releasePopover } from '../models/PopoverStack.ts';
import { ActivationKeys } from '../models/ActivationKeys.ts';
import { usePopoverEffect } from './usePopoverEffect.ts';
import type { AgentCatalogEntry, PluginManifest, SearchHit, SessionModes } from '../../types/models.ts';
import type { ApiClient } from '../../core/ApiClient.ts';
import { t } from '../i18n/i18n.ts';

/** 搜索防抖时长（ms）。 */
const SEARCH_DEBOUNCE_MS = 250;

/** 本弹层在互斥控制器里的身份。 */
const POPOVER_ID = 'addmenu';

/** AddMenu 组件的入参。 */
export interface AddMenuProps {
  /** 当前会话 id（目标 / 计划 / 绘图模式按会话持久化）。 */
  threadId: string;
  api: ApiClient;
  /** 打开文件选择器（复用 Composer 现有 FilePicker）。 */
  onAttach: () => void;
  /**
   * 应用会话模式（目标 / 计划 / 绘图）。
   *
   * 由控制器决定"立即落盘"还是"暂存到会话创建"（会话是惰性创建的，建会话前没有可写的 threadId）。
   * 缺省时不动作（单测/嵌入场景可省）。
   */
  onApplyMode?: (patch: {
    goal?: string;
    planMode?: boolean;
    sketchMode?: boolean;
  }) => Promise<'applied' | 'deferred'>;
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
          role="menuitem"
          aria-disabled={item.disabled === true ? 'true' : 'false'}
          // div 没有原生激活：菜单项必须自己进 Tab 序列并处理 Enter/Space（否则键盘用户
          // 只能打开菜单、选不了任何一项）。
          tabIndex={item.disabled === true ? -1 : 0}
          onClick={() => {
            if (!item.disabled) onItem(item.id);
          }}
          onKeyDown={(e: React.KeyboardEvent) => {
            if (item.disabled === true) return;
            ActivationKeys.activate(e, () => onItem(item.id));
          }}
        >
          <span className="addmenu-item-ico">{icon(item.icon, { size: 16 })}</span>
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

  // 打开时：挂外部点击监听（互斥登记同 hook），并一次性拉取会话模式 + 插件 + 智能体。
  usePopoverEffect(open, () => setOpen(false), POPOVER_ID);

  // 打开时取数；收起 / 卸载即清防抖（与弹层生命周期无关，故单独一个 effect）。
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
        // 防御：响应形状不符（旧版服务端没有该方法 ⇒ 回落成 `{}`）时给空列表，而不是把 `undefined`
        // 塞进 state——那会让 `sections()` 在 `.length`/`.map` 上抛错，React 直接把整块输入区卸载掉
        // （2026-09-27 在 stub 页实测：点＋后 `.addmenu` 整个消失）。
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
    return () => {
      if (searchTimer.current !== null) clearTimeout(searchTimer.current);
    };
  }, [open, api, threadId]);

  /**
   * 切换展开态（点击与键盘共用；打开时登记互斥，收起时释放）。
   * @returns 无
   */
  const flip = (): void => {
    const next = !open;
    if (next) claimPopover({ id: POPOVER_ID, close: () => setOpen(false) });
    else releasePopover(POPOVER_ID);
    setOpen(next);
  };

  /**
   * 触发按钮：阻断冒泡后切换展开态（阻断后不会被刚挂的外部点击监听立即关掉）。
   *
   * 打开前 claim 一次：`stopPropagation` 让全局 click 关不掉**别人**，
   * 若不主动顶掉，先开的弹层会继续留在屏幕上并被本菜单压住（用户实测到的重叠）。
   * @param e 点击事件
   */
  const toggle = (e: React.MouseEvent): void => {
    e.stopPropagation();
    flip();
  };

  /**
   * 切换会话模式（目标 / 计划 / 绘图）。
   *
   * **不再直接调 `modes.set`**（2026-10-06 真机报错）：会话是惰性创建的，建会话前 `threadId` 为空，
   * 直调就弹出「模式切换失败：modes.set 需要 threadId」。改由控制器决策：有会话 ⇒ 立刻落盘；
   * 没会话 ⇒ **暂存**，等会话一出现自动落盘，并如实告诉用户"发送第一条消息后生效"。
   * @param patch 模式补丁
   * @returns 无
   */
  const toggleMode = async (patch: {
    goal?: string;
    planMode?: boolean;
    sketchMode?: boolean;
  }): Promise<void> => {
    // 先**乐观**更新本地开关：暂存档下没有服务端回执，但用户的点击必须即时可见。
    if (patch.planMode !== undefined) setPlanMode(patch.planMode);
    if (patch.sketchMode !== undefined) setSketchMode(patch.sketchMode);
    if (patch.goal !== undefined) setGoal(patch.goal);
    try {
      const outcome =
        props.onApplyMode === undefined
          ? 'applied'
          : await props.onApplyMode(patch);
      if (outcome === 'deferred') onToast(PendingModes.deferredHint(), 'info');
    } catch (e) {
      onToast(t('模式切换失败：{msg}', { msg: (e as Error).message }), 'err');
    }
  };

  /** 编辑持续目标（经应用内对话框输入）。 @returns 无 */
  const onGoal = async (): Promise<void> => {
    const input = await dialog.prompt(t('设置要持续追求的目标（留空清除）：'), goal, {
      title: t('持续目标'),
      confirmLabel: t('保存'),
      placeholder: t('例如：把召回率提到 60%'),
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
      onToast(t('已选择智能体：{name}（载入会话后生效）', { name: agent?.name ?? id }));
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
      aria-label={t('添加')}
      onClick={toggle}
      // div role=button 没有原生激活：Enter/Space 打开或收起，Esc 收起（与外部点击同一条出口）。
      onKeyDown={(e: React.KeyboardEvent) => {
        if (e.key === 'Escape') {
          releasePopover(POPOVER_ID);
          setOpen(false);
          return;
        }
        if (ActivationKeys.activate(e, flip)) e.stopPropagation();
      }}
      tabIndex={0}
    >
      <span className="addmenu-ico">＋</span>
      {open ? (
        <div className="addmenu-pop" onClick={(e: React.MouseEvent) => e.stopPropagation()}>
          <div className="addmenu-search">
            <input
              className="addmenu-input"
              placeholder={t('搜索文件或聊天…')}
              value={query}
              onChange={(e: React.SyntheticEvent) => onQuery((e.target as HTMLInputElement).value)}
            />
          </div>
          <div className="addmenu-scroll">
            {sections.map((section) => renderSection(section, onItem))}
            {searching ? <div className="addmenu-loading">{t('搜索中…')}</div> : null}
            {files.length === 0 && chats.length === 0 && query.trim() !== '' && !searching ? (
              <div className="addmenu-loading">{t('没有匹配的文件或聊天')}</div>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
