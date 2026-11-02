// 左栏：会话列表 + 新建会话 + 工作区文件树。
//
// 结构（2026-11 S2 长函数拆分后）：
// - 组件体 = `React.memo` 包层的薄组合：取上下文 → 调 hooks → 交给 SessionPanelBody 画布局；
// - 会话 / 工作区 / 搜索 / 改名删除 / 分组 的 state 与动作下沉到 `./session/*.ts`（camelCase hook）；
// - 一等导航 / 项目切换器 / 区块头 / 搜索框 / 文件树区块下沉到同级 PascalCase 组件；
// - 仍留在这里的三块是**外壳内聚逻辑**：触屏拖拽（pointer + elementFromPoint）、行右键菜单
//   （锚点 / 贴边翻转 / 配置分组）、列表上下文组装（拖拽落点与行菜单接线）。前两块直接读
//   `#sessions` 容器坐标与 `.col.left` 容器 class，第三块是两者与三个视图的唯一接线点；且
//   `web/test/{sessionOrder,sessionTimeGrouping,menuPlacement}.test.ts` 的「接线守卫」按源码
//   锚点钉住它们——迁走会让判据假红（不是没拆，是与外壳耦合）。
//
// 层面改造沿革：服务经 useApp() 取用（替代旧基类访问器）；会话分组逻辑在 SessionGrouper
// （零 React，可单测）；文件树在 FileTree（展开态由组件内部管理）；行/卡/组/项目条/文件树的
// 渲染在 SessionViews（零状态纯渲染）。
//
// 搜索（A3）：本地即时过滤保留（filterSessions，零请求、输入即出结果）＋服务端 `search.all`
// （会话 + 工作区文件，分组展示、命中高亮/截断）。关键字为空时**不**打远端；防抖与乱序丢弃
// 由 models/SessionSearch 承担；↑/↓ 选中、Enter 打开走输入框的 combobox 语义。

import * as React from 'react';
import { useApp } from '../context.ts';
import { FolderPicker } from './FolderPicker.tsx';
import { SidebarFooter } from './SidebarFooter.tsx';
import { SessionPanelHead } from './SessionPanelHead.tsx';
import { SessionTreeSection } from './SessionTreeSection.tsx';
import { renderCardsView, renderGroupsView, renderTimeGroupsView } from './SessionViews.tsx';
import type { ListCtx, RowCtx } from './SessionViews.tsx';
import type { SidebarChrome } from './session/sidebarChrome.ts';
import { useSessionDelete } from './session/useSessionDelete.ts';
import { useSessionGrouping } from './session/useSessionGrouping.ts';
import { useSessionRename } from './session/useSessionRename.ts';
import { useSessionSearch } from './session/useSessionSearch.ts';
import { useSessionWorkspace } from './session/useSessionWorkspace.ts';
import type { SessionDeleteApi } from './session/useSessionDelete.ts';
import type { SessionGrouping } from './session/useSessionGrouping.ts';
import type { SessionRenameApi } from './session/useSessionRename.ts';
import type { SessionSearchApi } from './session/useSessionSearch.ts';
import type { SessionWorkspaceApi } from './session/useSessionWorkspace.ts';
import { nextPanelView } from './session/viewCycle.ts';
import type { PanelView } from './session/viewCycle.ts';
import { PathJoiner } from '../models/PathJoiner.ts';
import { MenuPlacement } from '../models/MenuPlacement.ts';
import { useRowMenuKeyboard } from './useRowMenuKeyboard.ts';
import { SessionOrder } from '../models/SessionOrder.ts';
import type { ApiClient } from '../../core/ApiClient.ts';
import type { SessionEntry } from '../shared.ts';
import { t } from '../i18n/i18n.ts';

/** SessionPanel 组件的入参。 */
export interface SessionPanelProps {
  sessions: SessionEntry[];
  currentThreadId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  onOpenFile: (path: string) => void;
  /** 重命名会话（自定义标题）。 */
  onRename: (id: string, title: string) => void | Promise<void>;
  /** 删除会话。 */
  onDelete: (id: string) => void | Promise<void>;
  /** 分叉会话为新副本。 */
  onFork: (id: string) => void | Promise<void>;
  /** 归档 / 恢复会话。 */
  onArchive?: (id: string, archived: boolean) => void | Promise<void>;
  /** 保存拖拽排序（新顺序的完整列表）。 */
  onReorder?: (ordered: SessionEntry[]) => void | Promise<void>;
  /** 切换项目成功后回调（App 刷新会话列表等）。 */
  onWorkspaceSwitched?: () => void;
  /** 当前项目路径解析后回调（中栏项目面包屑）。 */
  onWorkspaceResolved?: (path: string) => void;
  /** 会话列表是否显示**全部项目**（缺省只看当前项目，见 SessionsScope）。 */
  scopeAll?: boolean;
  /** 翻转显示范围（当前项目 ⇄ 全部项目）。 */
  onToggleScope?: () => void;
  /** 当前激活的右栏面板 key（「插件 / 设置」入口的高亮态）。 */
  activePane?: string;
  /** 打开右栏某面板（插件入口等走这里；设置不再走面板，见 onOpenSettings）。 */
  onOpenPane?: (key: string) => void;
  /** 打开命令面板（品牌头的入口按钮；快捷键 Ctrl/Cmd+P 仍可用）。 */
  onOpenPalette?: () => void;
  /** 打开设置模态（2026-10-17 起设置固定在页脚，见 SidebarFooter 头注释）。 */
  onOpenSettings?: () => void;
  /** SSE 是否已连接（页脚徽标；单测缺省按已连接渲染）。 */
  connected?: boolean;
  /** SSE 三态（页脚徽标文案 / 配色，见 SidebarFooter）。 */
  streamState?: 'open' | 'connecting' | 'closed';
  open: boolean;
  style?: Record<string, string>;
  /** 远端搜索防抖调度注入点（单测传「立即执行」以获得确定性，缺省走 setTimeout）。 */
  scheduleSearch?: (fn: () => void, ms: number) => unknown;
}

/**
 * 左栏会话与工作区面板：会话列表（列表 / 任务卡视图）、搜索（本地 + 远端）、重命名删除分叉、工作区切换。
 * 2026-11-01 `memo` 包层：SSE 事件 patch 每帧重渲染而本面板数据大多不变——配合 App 侧稳定回调束（usePanelParts），props 身份不变即整棵跳过。
 * @param props 组件入参
 * @returns 左栏节点
 */
export const SessionPanel = React.memo(function SessionPanel(props: SessionPanelProps): ReactElement {
  const { api, toast, workspaceEpoch } = useApp();
  const menu = useRowMenu();
  const chrome = useSidebarChrome(menu.close);
  const workspace = useSessionWorkspace({
    api,
    toast,
    workspaceEpoch,
    onNew: props.onNew,
    onWorkspaceResolved: props.onWorkspaceResolved,
    onWorkspaceSwitched: props.onWorkspaceSwitched,
    closeWsMenu: chrome.closeWsMenu,
  });
  const search = useSessionSearch({
    api,
    onSelect: props.onSelect,
    onOpenFile: props.onOpenFile,
    onExpand: chrome.expandRail,
    scheduleSearch: props.scheduleSearch,
  });
  const rename = useSessionRename(props.onRename);
  const remove = useSessionDelete(props.onDelete);
  const touch = useSessionTouch(props.sessions, props.onReorder);
  const grouping = useSessionGrouping();
  return (
    <SessionPanelBody
      api={api}
      panel={props}
      onArchive={props.onArchive}
      chrome={chrome}
      workspace={workspace}
      search={search}
      touch={touch}
      menu={menu}
      grouping={grouping}
      rename={rename}
      remove={remove}
    />
  );
});

/** SessionPanelBody 的入参：面板 props + 各路 hook 的产物（布局层不再取上下文）。 */
interface SessionPanelBodyProps {
  readonly api: ApiClient;
  readonly panel: SessionPanelProps;
  readonly onArchive: SessionPanelProps['onArchive'];
  readonly chrome: SidebarChrome;
  readonly workspace: SessionWorkspaceApi;
  readonly search: SessionSearchApi;
  readonly touch: SessionTouch;
  readonly menu: RowMenuState;
  readonly grouping: SessionGrouping;
  readonly rename: SessionRenameApi;
  readonly remove: SessionDeleteApi;
}

/**
 * 左栏布局层：把 hook 产物摊进 DOM（顺序与拆分前逐字一致）。
 * @param props 面板 props 与各路 hook 产物
 * @returns 左栏节点
 */
function SessionPanelBody(props: SessionPanelBodyProps): ReactElement {
  const { api, panel, chrome, workspace, search, touch, menu, grouping, rename, remove } = props;
  const [view, setView] = React.useState<'time' | 'ws' | 'cards'>('ws');
  const rowEdit = makeRowEdit(rename, remove);
  const listCtx = makeListCtx({
    sessions: panel.sessions,
    currentThreadId: panel.currentThreadId,
    query: search.query,
    wsPath: workspace.wsPath,
    grouping,
    rename,
    remove,
    onStartRename: rowEdit.startRename,
    onAskDelete: rowEdit.askDelete,
    onFork: panel.onFork,
    onArchive: props.onArchive,
    onReorder: panel.onReorder,
    onSelect: panel.onSelect,
    draggingId: touch.draggingId,
    setDraggingId: touch.setDraggingId,
    openMenu: menu.open,
  });
  const wsName = workspace.wsPath === '' ? t('未选择项目') : PathJoiner.basename(workspace.wsPath);
  return (
    <div className={'col left side' + (panel.open ? ' open' : '') + (chrome.rail ? ' rail' : '')} style={panel.style}>
      <SessionPanelHead
        panel={panel}
        chrome={chrome}
        workspace={workspace}
        search={search}
        wsName={wsName}
        view={view}
        onCycleView={() => setView((prev) => nextPanelView(prev))}
      />
      <div
        id="sessions"
        className={touch.draggingId === null ? undefined : 'touch-drag'}
        onPointerDown={touch.onPointerDown}
        onPointerUp={touch.onPointerUp}
        onPointerCancel={touch.onPointerCancel}
      >
        <SessionListView view={view} listCtx={listCtx} />
      </div>
      <SessionTreeSection
        rail={chrome.rail}
        open={chrome.treeOpen}
        onToggle={chrome.toggleTree}
        tree={workspace.tree}
        loaded={workspace.treeLoaded}
        error={workspace.treeError}
        onOpenFile={panel.onOpenFile}
      />
      {workspace.picking ? (
        <FolderPicker api={api} onCancel={workspace.cancelPicker} onPick={(path) => void workspace.pickProject(path)} />
      ) : null}
      <SessionRowMenuSlot
        menu={menu}
        sessions={panel.sessions}
        onSelect={panel.onSelect}
        onFork={panel.onFork}
        onReorder={panel.onReorder}
        onStartRename={rowEdit.startRename}
        onAssign={workspace.assignToCurrentProject}
        onAskDelete={rowEdit.askDelete}
      />
      {/* 页脚：连接状态 + 主题（原 TopBar 的状态 / 主题职责收编于此；设置走「全部面板」菜单）。 */}
      <SidebarFooter connected={panel.connected ?? true} streamState={panel.streamState} onOpenSettings={panel.onOpenSettings} />
    </div>
  );
}

/**
 * 会话列表视图：任务卡 / 按工作区分组 / 按时间分组（三态循环）。
 * @param props 视图与列表上下文
 * @returns 列表节点
 */
function SessionListView(props: { readonly view: PanelView; readonly listCtx: ListCtx }): ReactElement {
  const { view, listCtx } = props;
  return view === 'cards'
    ? renderCardsView(listCtx)
    : view === 'ws'
      ? renderGroupsView(listCtx)
      : renderTimeGroupsView(listCtx);
}

/** 行菜单锚点（会话 id + 视口坐标）。 */
interface RowMenuAnchor {
  readonly id: string;
  readonly x: number;
  readonly y: number;
}

/** 行右键菜单的状态与动作。 */
interface RowMenuState {
  /** 菜单锚点（null 表示未打开）。 */
  readonly anchor: RowMenuAnchor | null;
  /** 菜单**实际**左上角坐标（由 MenuPlacement 贴边翻转算出；null 表示尚未测量）。 */
  readonly pos: { x: number; y: number } | null;
  /** 右键菜单里的「配置」分组是否展开（2026-10-20：会话管理动作收进可展开分组）。 */
  readonly configOpen: boolean;
  /** 菜单元素（量它的真实宽高用于翻转判定）。 */
  readonly menuRef: React.RefObject<HTMLDivElement | null>;
  /** 在某行坐标处打开菜单。 */
  readonly open: (id: string, x: number, y: number) => void;
  /** 关闭菜单。 */
  readonly close: () => void;
  /** 展开 / 收起「配置」分组。 */
  readonly toggleConfig: () => void;
}

/**
 * 行右键菜单：锚点 / 展开态 / 贴边翻转 / 点空白与滚动关闭 / WAI-ARIA roving。
 * @returns 菜单状态与动作
 */
function useRowMenu(): RowMenuState {
  const [anchor, setAnchor] = React.useState<RowMenuAnchor | null>(null);
  const [configOpen, setConfigOpen] = React.useState<boolean>(false);
  const [pos, setPos] = React.useState<{ x: number; y: number } | null>(null);
  const menuRef = React.useRef<HTMLDivElement | null>(null);

  /** 打开菜单（先收起上次展开的「配置」分组）。 */
  const open = (id: string, x: number, y: number): void => {
    setConfigOpen(false);
    setAnchor({ id, x, y });
  };
  const close = React.useCallback((): void => setAnchor(null), []);
  const toggleConfig = (): void => setConfigOpen((v) => !v);

  // 右键菜单：点空白处 / 滚动即关闭（菜单 fixed 定位，滚动后位置就错了）。
  React.useEffect(() => {
    if (anchor === null) return;
    const onEvent = (e: Event): void => {
      // 菜单内部点击（如展开「配置」分组）不算“点空白处”，否则分组刚展开就被关掉。
      const el = menuRef.current;
      if (el !== null && e.target instanceof Node && el.contains(e.target)) return;
      setAnchor(null);
      setConfigOpen(false);
    };
    window.addEventListener('click', onEvent);
    window.addEventListener('scroll', onEvent, true);
    return () => {
      window.removeEventListener('click', onEvent);
      window.removeEventListener('scroll', onEvent, true);
    };
  }, [anchor]);
  useRowMenuKeyboard(anchor, menuRef); // W5 收口：行菜单 roving（打开落焦/↑↓/Home/End/归还行焦点）。

  // 贴边翻转：量出菜单真实宽高后把它夹进视口（贴近右下角时向左/向上翻，永不溢出屏幕边缘）。
  // 先隐藏后定位，避免用户看到「先在鼠标处闪一下再跳走」。
  React.useLayoutEffect(() => {
    if (anchor === null) {
      setPos(null);
      return;
    }
    const el = menuRef.current;
    if (el === null) return;
    // 菜单贴到左栏右侧：右键位置若落在会话行上，菜单不覆盖行，避免下一次点行误触菜单项。
    const leftCol = el.closest('.col.left');
    const colRight = leftCol === null ? 0 : leftCol.getBoundingClientRect().right;
    const anchorX = Math.max(anchor.x, colRight + 6);
    const p = MenuPlacement.clamp(
      anchorX,
      anchor.y,
      { w: el.offsetWidth, h: el.offsetHeight },
      { w: window.innerWidth, h: window.innerHeight },
    );
    setPos((prev) => (prev !== null && prev.x === p.x && prev.y === p.y ? prev : p));
  }, [anchor, configOpen]);

  return { anchor, pos, configOpen, menuRef, open, close, toggleConfig };
}

/**
 * 左栏外壳开合态 + `[` / Esc 快捷键。
 * @param closeMenu 关闭行菜单（Esc 用；`useCallback` 稳定身份，监听只挂一次）
 * @returns 开合态与动作
 */
function useSidebarChrome(closeMenu: () => void): SidebarChrome {
  const [rail, setRail] = React.useState<boolean>(false);
  const [treeOpen, setTreeOpen] = React.useState<boolean>(false);
  const [wsMenuOpen, setWsMenuOpen] = React.useState<boolean>(false);

  // 快捷键 `[` 收起/展开左栏；Esc 关掉右键菜单。挂在 window 上（焦点在左栏之外也能用），卸载即摘。
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const target = e.target as HTMLElement | null;
      const typing =
        target !== null &&
        (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);
      if (e.key === '[' && !typing) {
        e.preventDefault();
        setRail((prev) => !prev);
      }
      if (e.key === 'Escape') closeMenu();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [closeMenu]);

  /** 图标条态点区块头：展开左栏并展开文件区（否则点了没反应）。 */
  const toggleTree = (): void => {
    if (rail) {
      setRail(false);
      setTreeOpen(true);
      return;
    }
    setTreeOpen((v) => !v);
  };

  return {
    rail,
    treeOpen,
    wsMenuOpen,
    expandRail: (): void => setRail(false),
    toggleTree,
    toggleWsMenu: (): void => setWsMenuOpen((v) => !v),
    closeWsMenu: (): void => setWsMenuOpen(false),
  };
}

/** 触屏 / 指针拖拽的返回值。 */
interface SessionTouch {
  /** 正在被拖动的会话 id（拖拽排序高亮 / 落点判定）。 */
  readonly draggingId: string | null;
  readonly onPointerDown: (e: React.PointerEvent) => void;
  readonly onPointerUp: (e: React.PointerEvent) => void;
  readonly onPointerCancel: () => void;
  /** 清掉拖拽高亮。 */
  readonly setDraggingId: (id: string | null) => void;
}

/**
 * 触屏 / 指针拖拽入口。两条路径汇到同一个 `ListCtx.onDropOn`：
 * ① 拖拽把手（行首 `⠿`）：任何指针类型立即进入拖拽（把手 `touch-action:none`）；
 * ② 行本体：触屏长按 250ms 才进入（行本体留给滚动）；鼠标走既有 HTML5 DnD。
 *
 * 为什么留在 SessionPanel.tsx（而不是 `./session/`）：它直接读 `#sessions` 容器的指针事件与
 * `.col.left` 的行锚点，且 web/test/sessionOrder.test.ts 按源码锚点（pointerType / 250ms 长按 /
 * elementFromPoint）钉住实现——迁走会让「触屏拖拽仍走 pointer」的判据假红。
 * @param sessions 会话清单（拖拽排序的计算输入）
 * @param onReorder 排序回调（缺省则整块拖拽不生效）
 * @returns 拖拽态与指针处理器
 */
function useSessionTouch(sessions: SessionEntry[], onReorder?: SessionPanelProps['onReorder']): SessionTouch {
  const [draggingId, setDraggingId] = React.useState<string | null>(null);
  /** 触屏长按拖拽的在途状态（指针 id + 长按定时器）。 */
  const touchDragRef = React.useRef<{ id: string; timer: number | null } | null>(null);

  /** 清掉触屏长按定时器。 @returns 无 */
  const clearTouchTimer = (): void => {
    const cur = touchDragRef.current;
    if (cur !== null && cur.timer !== null) window.clearTimeout(cur.timer);
    if (cur !== null) cur.timer = null;
  };

  /** 指针按下：把手立即拖，行本体仅触屏长按拖。 @param e 指针事件 @returns 无 */
  const onPointerDown = (e: React.PointerEvent): void => {
    if (onReorder === undefined) return;
    const el = e.target as HTMLElement | null;
    if (el === null) return;
    const row = el.closest('[data-session-id]');
    const id = row?.getAttribute('data-session-id');
    if (id === null || id === undefined) return;
    // ① 抓到**拖拽把手**：任何指针类型都立即进入拖拽（把手自带 `touch-action:none`，
    //    所以触屏上也不需要长按 —— 这就是「短按即可拖」的入口）。
    if (el.closest('[data-drag-handle]') !== null) {
      setDraggingId(id);
      touchDragRef.current = { id, timer: null };
      return;
    }
    // ② 行内按钮不触发拖拽。
    if (el.closest('button') !== null) return;
    // ③ 触屏按在行本体上：仍保留长按 250ms（与「列表滚动」共存；想立即拖就用把手）。
    if (e.pointerType !== 'touch') return;
    const timer = window.setTimeout(() => setDraggingId(id), 250);
    touchDragRef.current = { id, timer };
  };

  /**
   * 触屏抬手：若处于拖拽态，则按落点行落下（用 `elementFromPoint` 命中，因为指针被隐式捕获在原行）。
   * @param e 指针事件
   * @returns 无
   */
  const onPointerUp = (e: React.PointerEvent): void => {
    const cur = touchDragRef.current;
    clearTouchTimer();
    touchDragRef.current = null;
    if (cur === null || draggingId === null) return;
    const target = document.elementFromPoint(e.clientX, e.clientY);
    const row = target instanceof Element ? target.closest('[data-session-id]') : null;
    const toId = row?.getAttribute('data-session-id') ?? null;
    setDraggingId(null);
    if (toId !== null && toId !== cur.id) {
      void onReorder?.(SessionOrder.move(sessions, cur.id, toId));
    }
  };

  /** 指针取消（滚动 / 系统手势打断）：清定时器与拖拽态。 @returns 无 */
  const onPointerCancel = (): void => {
    clearTouchTimer();
    touchDragRef.current = null;
    setDraggingId(null);
  };

  return { draggingId, onPointerDown, onPointerUp, onPointerCancel, setDraggingId };
}

/**
 * 构造「把某会话钉到最前 / 最后」的动作（右键菜单；与拖拽共用 `SessionOrder.move` + `onReorder` 一条通路）。
 * @param sessions 会话清单
 * @param onReorder 排序回调（缺省则不动作）
 * @returns 钉边动作
 */
function makeEdgeMover(
  sessions: SessionEntry[],
  onReorder?: SessionPanelProps['onReorder'],
): (id: string, edge: 'top' | 'bottom') => void {
  const moveToEdge = (id: string, edge: 'top' | 'bottom'): void => {
    if (onReorder === undefined) return;
    const first = sessions[0];
    const last = sessions[sessions.length - 1];
    const anchor = edge === 'top' ? first : last;
    if (anchor === undefined || anchor.id === id) return;
    void onReorder(SessionOrder.move(sessions, id, anchor.id));
  };
  return moveToEdge;
}

/**
 * 行内编辑态互斥接线：进入重命名即清删除确认，反之亦然（两者不会同时出现）。
 * @param rename 行内重命名态
 * @param remove 删除确认态
 * @returns 两个互斥入口
 */
function makeRowEdit(
  rename: SessionRenameApi,
  remove: SessionDeleteApi,
): { readonly startRename: (s: SessionEntry) => void; readonly askDelete: (id: string) => void } {
  return {
    startRename: (s: SessionEntry): void => {
      remove.cancel();
      rename.start(s);
    },
    askDelete: (id: string): void => {
      rename.cancel();
      remove.ask(id);
    },
  };
}

/** 组装列表上下文所需的全部成员（SessionViews 逐字段读取，无身份语义）。 */
interface ListCtxArgs {
  readonly sessions: SessionEntry[];
  readonly currentThreadId: string | null;
  readonly query: string;
  readonly wsPath: string;
  readonly grouping: SessionGrouping;
  readonly rename: SessionRenameApi;
  readonly remove: SessionDeleteApi;
  readonly onStartRename: (s: SessionEntry) => void;
  readonly onAskDelete: (id: string) => void;
  readonly onFork: (id: string) => void | Promise<void>;
  readonly onArchive?: SessionPanelProps['onArchive'];
  readonly onReorder?: SessionPanelProps['onReorder'];
  readonly onSelect: (id: string) => void;
  readonly draggingId: string | null;
  readonly setDraggingId: (id: string | null) => void;
  readonly openMenu: (id: string, x: number, y: number) => void;
}

/**
 * 组装行 / 列表上下文（三个视图与右键菜单共用同一份接线）。
 * @param a 面板状态与动作
 * @returns 列表上下文
 */
function makeListCtx(a: ListCtxArgs): ListCtx {
  const { sessions, onReorder } = a;
  const rowCtx: RowCtx = {
    renamingId: a.rename.renamingId,
    renameValue: a.rename.renameValue,
    confirmDeleteId: a.remove.confirmDeleteId,
    onStartRename: a.onStartRename,
    onRenameInput: a.rename.setValue,
    onCommitRename: (id: string) => void a.rename.commit(id),
    onCancelRename: a.rename.cancel,
    onAskDelete: a.onAskDelete,
    onCancelDelete: a.remove.cancel,
    onCommitDelete: (id: string) => void a.remove.commit(id),
    onFork: (id: string) => void a.onFork(id),
    onContextMenu: (id: string, x: number, y: number) => {
      a.openMenu(id, x, y);
    },
    ...(a.onArchive !== undefined ? { onArchive: a.onArchive } : {}),
  };
  return {
    ...rowCtx,
    sessions,
    currentThreadId: a.currentThreadId,
    query: a.query,
    wsPath: a.wsPath,
    collapsed: a.grouping.collapsed,
    limits: a.grouping.limits,
    onSelect: a.onSelect,
    onToggleGroup: a.grouping.onToggleGroup,
    onShowAll: a.grouping.onShowAll,
    draggingId: a.draggingId,
    onDragStart: (id: string) => a.setDraggingId(id),
    onDragEnd: () => a.setDraggingId(null),
    onDropOn: (id: string) => {
      const from = a.draggingId;
      a.setDraggingId(null);
      if (from === null || from === id || onReorder === undefined) return;
      void onReorder(SessionOrder.move(sessions, from, id));
    },
  };
}

/** SessionRowMenuSlot 组件的入参。 */
interface SessionRowMenuSlotProps {
  readonly menu: RowMenuState;
  readonly sessions: SessionEntry[];
  readonly onSelect: (id: string) => void;
  readonly onFork: (id: string) => void | Promise<void>;
  readonly onReorder?: SessionPanelProps['onReorder'];
  readonly onStartRename: (s: SessionEntry) => void;
  readonly onAssign: (id: string) => void | Promise<void>;
  readonly onAskDelete: (id: string) => void;
}

/**
 * 行菜单槽：按当前锚点找到会话行再渲染菜单（锚点失效时整块不渲染）。
 * @param props 菜单状态、会话清单与动作
 * @returns 菜单节点；无锚点或找不到行时为 null
 */
function SessionRowMenuSlot(props: SessionRowMenuSlotProps): ReactElement | null {
  const { menu } = props;
  const anchor = menu.anchor;
  const session = anchor === null ? undefined : props.sessions.find((s) => s.id === anchor.id);
  if (anchor === null || session === undefined) return null;
  return (
    <SessionRowMenu
      anchor={anchor}
      pos={menu.pos}
      configOpen={menu.configOpen}
      menuRef={menu.menuRef}
      session={session}
      onToggleConfig={menu.toggleConfig}
      onClose={menu.close}
      onSelect={props.onSelect}
      onStartRename={props.onStartRename}
      onFork={props.onFork}
      moveToEdge={makeEdgeMover(props.sessions, props.onReorder)}
      onAssign={props.onAssign}
      onAskDelete={props.onAskDelete}
    />
  );
}

/** SessionRowMenu 组件的入参。 */
interface SessionRowMenuProps {
  readonly anchor: RowMenuAnchor;
  readonly pos: { x: number; y: number } | null;
  readonly configOpen: boolean;
  readonly menuRef: React.RefObject<HTMLDivElement | null>;
  readonly session: SessionEntry;
  readonly onToggleConfig: () => void;
  readonly onClose: () => void;
  readonly onSelect: (id: string) => void;
  readonly onStartRename: (s: SessionEntry) => void;
  readonly onFork: (id: string) => void | Promise<void>;
  readonly moveToEdge: (id: string, edge: 'top' | 'bottom') => void;
  readonly onAssign: (id: string) => void | Promise<void>;
  readonly onAskDelete: (id: string) => void;
}

/**
 * 行右键菜单：打开 / 配置（管理动作收在可展开子分组里）。
 * @param props 组件入参
 * @returns 菜单节点
 */
function SessionRowMenu(props: SessionRowMenuProps): ReactElement {
  const { anchor, pos, configOpen, menuRef, session } = props;
  return (
    <div
      className="row-menu"
      ref={menuRef}
      style={{
        left: (pos?.x ?? anchor.x) + 'px',
        top: (pos?.y ?? anchor.y) + 'px',
        visibility: pos === null ? 'hidden' : 'visible',
      }}
      role="menu"
    >
      <button
        role="menuitem"
        onClick={() => {
          props.onClose();
          props.onSelect(anchor.id);
        }}
      >
        {t('打开')}
      </button>
      <button
        role="menuitem"
        className="row-menu-config"
        aria-expanded={configOpen ? 'true' : 'false'}
        onClick={props.onToggleConfig}
      >
        <span>{t('配置')}</span>
        <span className="row-menu-caret" aria-hidden="true">
          {configOpen ? '▾' : '▸'}
        </span>
      </button>
      {configOpen ? (
        <RowMenuConfig
          session={session}
          onClose={props.onClose}
          onStartRename={props.onStartRename}
          onFork={props.onFork}
          moveToEdge={props.moveToEdge}
          onAssign={props.onAssign}
          onAskDelete={props.onAskDelete}
        />
      ) : null}
    </div>
  );
}

/** RowMenuConfig 组件的入参。 */
interface RowMenuConfigProps {
  readonly session: SessionEntry;
  readonly onClose: () => void;
  readonly onStartRename: (s: SessionEntry) => void;
  readonly onFork: (id: string) => void | Promise<void>;
  readonly moveToEdge: (id: string, edge: 'top' | 'bottom') => void;
  readonly onAssign: (id: string) => void | Promise<void>;
  readonly onAskDelete: (id: string) => void;
}

/**
 * 行菜单里的「配置」分组（2026-10-20：会话管理动作收进可展开分组）。
 *
 * 排序：不用拖拽也能把会话钉到最前/最后（业界常见式右键菜单的做法）。
 * 归入当前项目（2026-10-07 用户口径「各自分离不要出现串项目」）：只对**没有归属或归属别家**
 * 的会话显示（当前项目自己的会话点了没意义）。改的是存档首行 session_meta 的 workspace
 * （归一值），历史事件逐字不动；落盘后刷新列表即可看到它换组。
 * @param props 会话与动作
 * @returns 管理动作分组节点
 */
function RowMenuConfig(props: RowMenuConfigProps): ReactElement {
  const { session } = props;
  return (
    <div className="row-menu-sub" role="group" aria-label={t('会话配置')}>
      <button
        role="menuitem"
        onClick={() => {
          props.onClose();
          props.onStartRename(session);
        }}
      >
        {t('重命名')}
      </button>
      <button
        role="menuitem"
        onClick={() => {
          props.onClose();
          void props.onFork(session.id);
        }}
      >
        {t('复制为副本')}
      </button>
      <button
        role="menuitem"
        onClick={() => {
          props.onClose();
          props.moveToEdge(session.id, 'top');
        }}
      >
        {t('移到顶部')}
      </button>
      <button
        role="menuitem"
        onClick={() => {
          props.onClose();
          props.moveToEdge(session.id, 'bottom');
        }}
      >
        {t('移到底部')}
      </button>
      <button
        role="menuitem"
        onClick={() => {
          props.onClose();
          void props.onAssign(session.id);
        }}
      >
        {t('归入当前项目')}
      </button>
      <button
        role="menuitem"
        className="danger"
        onClick={() => {
          props.onClose();
          props.onAskDelete(session.id);
        }}
      >
        {t('删除…')}
      </button>
    </div>
  );
}
