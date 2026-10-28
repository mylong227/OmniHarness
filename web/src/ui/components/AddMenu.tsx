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
import { MenuFocusModel } from '../models/MenuFocusModel.ts';
import { usePopoverEffect } from './usePopoverEffect.ts';
import { useMenuNavigation } from './useMenuNavigation.ts';
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
export function AddMenu(props: AddMenuProps): ReactElement {
  const { threadId, api, onAttach, onToast, onOpenTab, onOpenFile, onLoadThread } = props;
  const { dialog } = useApp();
  const [open, setOpen] = React.useState<boolean>(false);
  /** 打开时取的模式 / 插件 / 智能体（见 useAddMenuData）。 */
  const data = useAddMenuData({ open, api, threadId });
  const { goal, planMode, sketchMode, plugins, pluginsLoading, agents, agentsLoading, patchModes } = data;
  const [query, setQuery] = React.useState<string>('');
  const [files, setFiles] = React.useState<readonly SearchHit[]>([]);
  const [chats, setChats] = React.useState<readonly SearchHit[]>([]);
  const [searching, setSearching] = React.useState<boolean>(false);
  /** 搜索关键字（用于丢弃迟到响应）。 */
  const searchSeq = React.useRef<number>(0);
  /** 搜索防抖定时器。 */
  const searchTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  /** 触发器引用（Esc 收起后把焦点还给它）。 */
  const triggerRef = React.useRef<HTMLDivElement | null>(null);

  /** 收起（释放互斥）并把焦点还给触发器。 */
  const closeAndReturnFocus = (): void => {
    releasePopover(POPOVER_ID);
    setOpen(false);
    triggerRef.current?.focus();
  };

  // 菜单键盘导航（roving tabindex + ↑/↓/Home/End）抽在 hook 里。
  const menu = useMenuNavigation({
    onEscape: closeAndReturnFocus,
    ensureOpen: () => {
      if (!open) flip();
    },
  });
  // 打开时：挂外部点击监听（互斥登记同 hook），并一次性拉取会话模式 + 插件 + 智能体。
  usePopoverEffect(open, () => setOpen(false), POPOVER_ID);

  // 收起即清防抖（与弹层生命周期无关，故单独一个 effect）。
  React.useEffect(() => {
    if (open || searchTimer.current === null) return;
    clearTimeout(searchTimer.current);
  }, [open]);


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
    patchModes(patch);
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
    // 关键字一变就作废在途请求：删空输入或改字后，旧响应不得再覆盖当前结果
    // （此前只清防抖定时器，慢请求后到会把「已删空的列表」重新填满旧命中）。
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
    <AddMenuTrigger
      open={open}
      onToggle={toggle}
      triggerRef={triggerRef}
      // div role=button 没有原生激活：Enter/Space 打开或收起，Esc 收起（与外部点击同一条出口）。
      onKeyDown={(e: React.KeyboardEvent) => {
        if (e.key === 'Escape') {
          releasePopover(POPOVER_ID);
          setOpen(false);
          return;
        }
        if (ActivationKeys.activate(e, flip)) {
          e.stopPropagation();
          return;
        }
        menu.onTriggerKey(e);
      }}
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
