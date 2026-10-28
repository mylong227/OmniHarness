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
import { ActivationKeys } from '../models/ActivationKeys.ts';
import { usePopoverMenu } from './usePopoverMenu.ts';
import { MenuFocusModel } from '../models/MenuFocusModel.ts';
import { useAddMenuData } from './useAddMenuData.ts';
import type { SearchHit } from '../../types/models.ts';
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
 * @param focus 键盘导航状态（roving tabindex 的活动下标 + 本分组的起点）
 * @returns 分组节点
 */
function renderSection(
  section: AddMenuSection,
  onItem: (id: string) => void,
  focus: { active: number; base: number; setActive: (index: number) => void },
): ReactElement {
  let enabledOffset = 0;
  return (
    <div className="addmenu-sec" key={section.id}>
      {section.title ? <div className="addmenu-sec-title">{section.title}</div> : null}
      {section.items.map((item) => {
        const index = focus.base + enabledOffset;
        if (item.disabled !== true) enabledOffset += 1;
        return (
          <div
            key={item.id}
            className={'addmenu-item' + (item.active ? ' active' : '') + (item.disabled ? ' disabled' : '')}
            role="menuitem"
            aria-disabled={item.disabled === true ? 'true' : 'false'}
            // div 没有原生激活：菜单项必须自己进 Tab 序列并处理 Enter/Space（否则键盘用户
            // 只能打开菜单、选不了任何一项）。roving tabindex：只有活动项在 Tab 序列里。
            {...(item.disabled === true
              ? {}
              : { 'data-menu-item': true, onFocus: () => focus.setActive(index) })}
            tabIndex={item.disabled === true ? -1 : MenuFocusModel.tabIndexFor(index, focus.active)}
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
        );
      })}
    </div>
  );
}

/** 弹出层属性。 */
interface AddMenuPopoverProps {
  /** 搜索关键字。 */
  readonly query: string;
  /** 关键字变更。 */
  readonly onQuery: (value: string) => void;
  /** 分组数据（已按当前查询词算出）。 */
  readonly sections: readonly AddMenuSection[];
  /** 是否在搜索中。 */
  readonly searching: boolean;
  /** 是否要显示「没有匹配」空态（有查询词、不在搜索中、且无命中）。 */
  readonly empty: boolean;
  /** 当前活动项（roving tabindex）。 */
  readonly activeItem: number;
  /** 同步活动项。 */
  readonly setActiveItem: (index: number) => void;
  /** 点击菜单项。 */
  readonly onItem: (id: string) => void;
  /** 菜单键盘处理。 */
  readonly onMenuKeyDown: (e: React.KeyboardEvent) => void;
  /** 菜单容器 ref。 */
  readonly menuRef: React.MutableRefObject<HTMLDivElement | null>;
}

/**
 * 「＋」的弹出层：搜索框 + 分组列表 + 空/加载提示。
 * @param props 查询词、分组与键盘接线
 * @returns 弹出层节点
 */
function AddMenuPopover(props: AddMenuPopoverProps): ReactElement {
  const { query, onQuery, sections, searching, empty, activeItem, setActiveItem, onItem } = props;
  /** 已启用项在整张菜单里的起始下标（roving tabindex 需要全局序号）。 */
  let base = 0;
  return (
    <div
      className="addmenu-pop"
      onClick={(e: React.MouseEvent) => e.stopPropagation()}
      onKeyDown={props.onMenuKeyDown}
      ref={(el: HTMLDivElement | null) => {
        props.menuRef.current = el;
      }}
    >
      <div className="addmenu-search">
        <input
          className="addmenu-input"
          placeholder={t('搜索文件或聊天…')}
          value={query}
          onChange={(e: React.SyntheticEvent) => onQuery((e.target as HTMLInputElement).value)}
        />
      </div>
      <div className="addmenu-scroll">
        {sections.map((section) => {
          const node = renderSection(section, onItem, { active: activeItem, base, setActive: setActiveItem });
          base += section.items.filter((item) => item.disabled !== true).length;
          return node;
        })}
        {searching ? <div className="addmenu-loading">{t('搜索中…')}</div> : null}
        {empty ? <div className="addmenu-loading">{t('没有匹配的文件或聊天')}</div> : null}
      </div>
    </div>
  );
}

/** 触发器外壳属性。 */
interface AddMenuTriggerProps {
  /** 展开态。 */
  readonly open: boolean;
  /** 点击切换。 */
  readonly onToggle: (e: React.MouseEvent) => void;
  /** 键盘。 */
  readonly onKeyDown: (e: React.KeyboardEvent) => void;
  /** 触发器 ref（Esc 收起后归还焦点）。 */
  readonly triggerRef: React.MutableRefObject<HTMLDivElement | null>;
  /** 展开时的弹出层。 */
  readonly children: React.ReactNode;
}

/**
 * 「＋」触发器：一枚 `role=button` 的图标 + 弹出层。
 * @param props 触发器属性与弹出层
 * @returns 触发器节点
 */
function AddMenuTrigger(props: AddMenuTriggerProps): ReactElement {
  const { open, onToggle, onKeyDown, triggerRef, children } = props;
  return (
    <div
      className="addmenu"
      role="button"
      aria-haspopup="menu"
      aria-expanded={open ? 'true' : 'false'}
      aria-label={t('添加')}
      onClick={onToggle}
      onKeyDown={onKeyDown}
      tabIndex={0}
      ref={(el: HTMLDivElement | null) => {
        triggerRef.current = el;
      }}
    >
      <span className="addmenu-ico">＋</span>
      {children}
    </div>
  );
}

/**
 * 「+」添加菜单：分组列出添加入口、插件、智能体与文件/聊天搜索。
 * @param props 组件入参
 * @returns 菜单节点
 */
/**
 * 菜单搜索（防抖 + 迟到响应丢弃）。
 * @param api RPC 客户端。
 * @param open 是否展开。
 * @returns 查询、结果与输入回调。
 */
function useAddMenuSearch(
  api: ApiClient,
  open: boolean,
): {
  query: string;
  files: readonly SearchHit[];
  chats: readonly SearchHit[];
  searching: boolean;
  onQuery: (value: string) => void;
  clearSearch: () => void;
} {
  const [query, setQuery] = React.useState<string>('');
  const [files, setFiles] = React.useState<readonly SearchHit[]>([]);
  const [chats, setChats] = React.useState<readonly SearchHit[]>([]);
  const [searching, setSearching] = React.useState<boolean>(false);
  const searchSeq = React.useRef<number>(0);
  const searchTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  React.useEffect(() => {
    if (open || searchTimer.current === null) return;
    clearTimeout(searchTimer.current);
  }, [open]);
  const onQuery = (value: string): void => {
    setQuery(value);
    if (searchTimer.current !== null) clearTimeout(searchTimer.current);
    const seq = ++searchSeq.current;
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
          if (seq !== searchSeq.current) return;
          setFiles(r.files);
          setChats(r.chats);
          setSearching(false);
        })
        .catch(() => {
          if (seq === searchSeq.current) setSearching(false);
        });
    }, SEARCH_DEBOUNCE_MS);
  };
  const clearSearch = (): void => {
    setFiles([]);
    setChats([]);
    setSearching(false);
  };
  return { query, files, chats, searching, onQuery, clearSearch };
}

/**
 * 按菜单项 id 分派动作。
 * @param id 菜单项 id。
 * @param ctx 回调集合。
 * @returns 无。
 */
function dispatchAddMenuItem(
  id: string,
  ctx: {
    onAttach: () => void;
    onGoal: () => void;
    planMode: boolean;
    sketchMode: boolean;
    toggleMode: (patch: { planMode?: boolean; sketchMode?: boolean }) => Promise<void>;
    onOpenTab: (key: string) => void;
    agents: readonly { id: string; name: string }[];
    onToast: (msg: string, kind?: 'info' | 'err') => void;
    onOpenFile: (path: string) => void;
    onLoadThread: (id: string) => void;
    close: () => void;
  },
): void {
  if (id === 'attach') {
    ctx.onAttach();
    ctx.close();
  } else if (id === 'goal') ctx.onGoal();
  else if (id === 'plan') void ctx.toggleMode({ planMode: !ctx.planMode });
  else if (id === 'sketch') void ctx.toggleMode({ sketchMode: !ctx.sketchMode });
  else if (id.startsWith('plugin:')) {
    ctx.onOpenTab('plugins');
    ctx.close();
  } else if (id.startsWith('agent:')) {
    const agent = ctx.agents.find((a) => 'agent:' + a.id === id);
    ctx.onToast(t('已选择智能体：{name}（载入会话后生效）', { name: agent?.name ?? id }));
    ctx.close();
  } else if (id.startsWith('file:')) {
    ctx.onOpenFile(id.slice('file:'.length));
    ctx.close();
  } else if (id.startsWith('chat:')) {
    ctx.onLoadThread(id.slice('chat:'.length));
    ctx.close();
  }
}

/**
 * 会话模式编辑（目标 / 计划 / 绘图）。
 * @param opts 当前值、补丁函数与提示。
 * @returns 切换与目标编辑动作。
 */
function useAddMenuModes(opts: {
  goal: string;
  patchModes: (patch: { goal?: string; planMode?: boolean; sketchMode?: boolean }) => void;
  onApplyMode?: ((patch: { goal?: string; planMode?: boolean; sketchMode?: boolean }) => Promise<'applied' | 'deferred'>) | undefined;
  onToast: (msg: string, kind?: 'info' | 'err') => void;
  dialog: { prompt: (msg: string, value: string, opts?: Record<string, unknown>) => Promise<string | null> };
}): {
  toggleMode: (patch: { goal?: string; planMode?: boolean; sketchMode?: boolean }) => Promise<void>;
  onGoal: () => Promise<void>;
} {
  const { goal, patchModes, onApplyMode, onToast, dialog } = opts;
  const toggleMode = async (patch: {
    goal?: string;
    planMode?: boolean;
    sketchMode?: boolean;
  }): Promise<void> => {
    patchModes(patch);
    try {
      const outcome = onApplyMode === undefined ? 'applied' : await onApplyMode(patch);
      if (outcome === 'deferred') onToast(PendingModes.deferredHint(), 'info');
    } catch (e) {
      onToast(t('模式切换失败：{msg}', { msg: (e as Error).message }), 'err');
    }
  };
  const onGoal = async (): Promise<void> => {
    const input = await dialog.prompt(t('设置要持续追求的目标（留空清除）：'), goal, {
      title: t('持续目标'),
      confirmLabel: t('保存'),
      placeholder: t('例如：把召回率提到 60%'),
    });
    if (input === null) return;
    void toggleMode({ goal: input.trim() });
  };
  return { toggleMode, onGoal };
}

/**
 * 输入区「+」菜单。
 * @param props 会话、附件与跳转回调。
 * @returns 菜单节点。
 */
export function AddMenu(props: AddMenuProps): ReactElement {
  const { threadId, api, onAttach, onToast, onOpenTab, onOpenFile, onLoadThread } = props;
  const { dialog } = useApp();
  const { open, setOpen, triggerRef, menu, toggle, onTriggerKeyDown } = usePopoverMenu(POPOVER_ID);
  /** 打开时取的模式 / 插件 / 智能体（见 useAddMenuData）。 */
  const data = useAddMenuData({ open, api, threadId });
  const { goal, planMode, sketchMode, plugins, pluginsLoading, agents, agentsLoading, patchModes } = data;
  const { query, files, chats, searching, onQuery } = useAddMenuSearch(api, open);

  const { toggleMode, onGoal } = useAddMenuModes({
    goal,
    patchModes,
    onApplyMode: props.onApplyMode,
    onToast,
    dialog,
  });

  const onItem = (id: string): void =>
    dispatchAddMenuItem(id, {
      onAttach,
      onGoal: () => void onGoal(),
      planMode,
      sketchMode,
      toggleMode,
      onOpenTab,
      agents,
      onToast,
      onOpenFile,
      onLoadThread,
      close: () => setOpen(false),
    });

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
    <AddMenuTrigger
      open={open}
      onToggle={toggle}
      triggerRef={triggerRef}
      onKeyDown={onTriggerKeyDown}
    >
      {open ? (
        <AddMenuPopover
          query={query}
          onQuery={onQuery}
          sections={sections}
          searching={searching}
          empty={files.length === 0 && chats.length === 0 && query.trim() !== '' && !searching}
          activeItem={menu.activeItem}
          setActiveItem={menu.setActiveItem}
          onItem={onItem}
          onMenuKeyDown={menu.onMenuKeyDown}
          menuRef={menu.menuRef}
        />
      ) : null}
    </AddMenuTrigger>
  );
}
