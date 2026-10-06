// 左栏：会话列表 + 新建会话 + 工作区文件树。
//
// 面向对象改造：
// - 服务经 useApp() 取用（替代旧基类访问器），十三份 state 收敛为字段级 useState；
// - 会话分组逻辑下沉到 SessionGrouper（零 React，可单测）；
// - 文件树节点拆为 TreeNode 组件（各自管理展开态）；
// - 行/卡/组/项目条/文件树的渲染下沉到 SessionViews（零状态纯渲染）。
//
// 搜索（A3）：本地即时过滤保留（filterSessions，零请求、输入即出结果）＋服务端 `search.all`
// （会话 + 工作区文件，分组展示、命中高亮/截断）。关键字为空时**不**打远端；防抖与乱序丢弃
// 由 models/SessionSearch 承担；↑/↓ 选中、Enter 打开走输入框的 combobox 语义。

import { React } from '../deps.js';
import { useApp } from '../context.js';
import { FolderPicker } from './FolderPicker.js';
import { SearchResults, SEARCH_LIST_ID } from './SearchResults.js';
import { SessionSearch } from '../models/SessionSearch.js';
import type { SearchGroup } from '../models/SearchHitGrouper.js';
import {
  renderCardsView,
  renderGroupsView,
  renderProjectsView,
  renderTimeGroupsView,
  renderTreeView,
} from './SessionViews.js';
import type { ListCtx, RowCtx } from './SessionViews.js';
import { PathJoiner } from '../models/PathJoiner.js';
import { MenuPlacement } from '../models/MenuPlacement.js';
import { SessionOrder } from '../models/SessionOrder.js';
import type { FsNode } from '../../types/models.js';
import type { SearchHit } from '../../types/models.js';
import type { SessionEntry } from '../shared.js';

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
  /** 会话列表是否显示**全部项目**（缺省只看当前项目，见 SessionsScope）。 */
  scopeAll?: boolean;
  /** 翻转显示范围（当前项目 ⇄ 全部项目）。 */
  onToggleScope?: () => void;
  open: boolean;
  style?: Record<string, string>;
  /** 远端搜索防抖调度注入点（单测传「立即执行」以获得确定性，缺省走 setTimeout）。 */
  scheduleSearch?: (fn: () => void, ms: number) => unknown;
}

/**
 * 左栏会话与工作区面板：会话列表（列表 / 任务卡视图）、搜索（本地 + 远端）、重命名删除分叉、工作区切换。
 * @param props 组件入参
 * @returns 左栏节点
 */
export function SessionPanel(props: SessionPanelProps): ReactElement {
  const {
    sessions,
    currentThreadId,
    onSelect,
    onNew,
    onOpenFile,
    onRename,
    onDelete,
    onFork,
    onWorkspaceSwitched,
    scopeAll,
    onToggleScope,
    open,
    style,
  } = props;
  const { api, toast } = useApp();
  const [tree, setTree] = React.useState<FsNode[]>([]);
  const [treeLoaded, setTreeLoaded] = React.useState<boolean>(false);
  const [treeError, setTreeError] = React.useState<string | null>(null);
  const [collapsed, setCollapsed] = React.useState<Record<string, boolean>>({});
  const [limits, setLimits] = React.useState<Record<string, number>>({});
  const [wsPath, setWsPath] = React.useState<string>('');
  const [projects, setProjects] = React.useState<string[]>([]);
  const [picking, setPicking] = React.useState<boolean>(false);
  const [view, setView] = React.useState<'time' | 'ws' | 'cards'>('time');
  const [query, setQuery] = React.useState<string>('');
  /** 顶部工作区切换器是否展开（Codex 式：项目是一等入口，占据左栏最上方）。 */
  const [wsMenuOpen, setWsMenuOpen] = React.useState<boolean>(false);
  /** 两个区块是否展开（会话 / 文件），可按需收起，让另一块占满左栏。 */
  const [sessionsOpen, setSessionsOpen] = React.useState<boolean>(true);
  const [treeOpen, setTreeOpen] = React.useState<boolean>(true);
  /** 左栏是否收成图标条（Codex 式可折叠侧栏；快捷键 `[`）。 */
  const [rail, setRail] = React.useState<boolean>(false);
  /** 行右键菜单（会话 id + 视口坐标；null 表示未打开）。 */
  const [menu, setMenu] = React.useState<{ id: string; x: number; y: number } | null>(null);
  /** 菜单**实际**左上角坐标（由 MenuPlacement 贴边翻转算出；null 表示尚未测量）。 */
  const [menuPos, setMenuPos] = React.useState<{ x: number; y: number } | null>(null);
  /** 菜单元素（量它的真实宽高用于翻转判定）。 */
  const menuRef = React.useRef<HTMLDivElement | null>(null);
  /** 搜索输入框（收成图标条时点 🔍 展开并聚焦它）。 */
  const searchInputRef = React.useRef<HTMLInputElement | null>(null);
  /** 正在被拖动的会话 id（拖拽排序高亮 / 落点判定）。 */
  const [draggingId, setDraggingId] = React.useState<string | null>(null);
  /** 触屏长按拖拽的在途状态（指针 id + 长按定时器）。 */
  const touchDragRef = React.useRef<{ id: string; timer: number | null } | null>(null);

  /** 清掉触屏长按定时器。 @returns 无 */
  const clearTouchTimer = (): void => {
    const cur = touchDragRef.current;
    if (cur !== null && cur.timer !== null) window.clearTimeout(cur.timer);
    if (cur !== null) cur.timer = null;
  };

  /**
   * 触屏 / 指针拖拽入口。
   *
   * 两条路径，最终都汇到同一个 `ListCtx.onDropOn`：
   * ① **拖拽把手**（行首 `⠿`）：任何指针类型**立即**进入拖拽（把手自身 `touch-action:none`，
   *    触屏也不与滚动冲突）——「短按即可拖」；
   * ② **行本体**：触屏长按 250ms 才进入（行本体要留给滚动，这是与滚动手势共存的取舍）；鼠标走
   *    既有的 HTML5 DnD。
   * @param e 指针事件
   * @returns 无
   */
  const onSessionsPointerDown = (e: React.PointerEvent): void => {
    if (props.onReorder === undefined) return;
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
  const onSessionsPointerUp = (e: React.PointerEvent): void => {
    const cur = touchDragRef.current;
    clearTouchTimer();
    touchDragRef.current = null;
    if (cur === null || draggingId === null) return;
    const target = document.elementFromPoint(e.clientX, e.clientY);
    const row = target instanceof Element ? target.closest('[data-session-id]') : null;
    const toId = row?.getAttribute('data-session-id') ?? null;
    setDraggingId(null);
    if (toId !== null && toId !== cur.id) {
      void props.onReorder?.(SessionOrder.move(sessions, cur.id, toId));
    }
  };
  const [renamingId, setRenamingId] = React.useState<string | null>(null);
  const [renameValue, setRenameValue] = React.useState<string>('');
  const [confirmDeleteId, setConfirmDeleteId] = React.useState<string | null>(null);
  /** 远端搜索的分组结果（空数组表示尚无结果）。 */
  const [groups, setGroups] = React.useState<readonly SearchGroup[]>([]);
  /** 远端搜索是否在途。 */
  const [searching, setSearching] = React.useState<boolean>(false);
  /** 远端结果的选中序号（↑/↓ 与 Enter 共用）。 */
  const [hitIndex, setHitIndex] = React.useState<number>(-1);

  // 搜索状态机跨渲染复用；onUpdate 把权威快照搬到 state（渲染用镜像，见 SessionSearch 头注释）。
  const searchRef = React.useRef<SessionSearch | null>(null);
  if (searchRef.current === null) {
    searchRef.current = new SessionSearch({
      search: (q: string) => api.searchAll(q),
      onUpdate: () => {
        const s = searchRef.current;
        if (s === null) return;
        setGroups(s.groupList());
        setSearching(s.isLoading());
        setHitIndex(s.selectedIndex());
      },
      ...(props.scheduleSearch !== undefined ? { schedule: props.scheduleSearch } : {}),
    });
  }
  const search = searchRef.current;

  // 挂载拉取工作区清单（当前路径 + 已添加项目）。
  React.useEffect(() => {
    api
      .listWorkspaces()
      .then((r) => {
        setWsPath(r.current);
        setProjects(r.workspaces);
      })
      .catch(() => {
        /* 静默：分组标题退化为通用名 */
      });
  }, [api]);

  // 工作区变化即重刷文件树（原 componentDidUpdate 的 prevState.wsPath 比对）；alive 防迟到回写。
  React.useEffect(() => {
    let alive = true;
    api
      .listFs(3)
      .then((r) => {
        if (alive) {
          setTree(r.tree || []);
          setTreeLoaded(true);
          setTreeError(null);
        }
      })
      .catch(() => {
        if (alive) {
          setTreeError('文件树不可用');
          setTreeLoaded(true);
        }
      });
    return () => {
      alive = false;
    };
  }, [api, wsPath]);

  // 卸载即丢弃在途防抖（否则定时器会在组件消失后打一次远端搜索）。
  React.useEffect(() => () => search.dispose(), [search]);

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
      if (e.key === 'Escape') setMenu(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // 右键菜单：点空白处 / 滚动即关闭（菜单 fixed 定位，滚动后位置就错了）。
  React.useEffect(() => {
    if (menu === null) return;
    const close = (): void => setMenu(null);
    window.addEventListener('click', close);
    window.addEventListener('scroll', close, true);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('scroll', close, true);
    };
  }, [menu]);

  // 贴边翻转：量出菜单真实宽高后把它夹进视口（贴近右下角时向左/向上翻，永不溢出屏幕边缘）。
  // 先隐藏后定位，避免用户看到「先在鼠标处闪一下再跳走」。
  React.useLayoutEffect(() => {
    if (menu === null) {
      setMenuPos(null);
      return;
    }
    const el = menuRef.current;
    if (el === null) return;
    const p = MenuPlacement.clamp(
      menu.x,
      menu.y,
      { w: el.offsetWidth, h: el.offsetHeight },
      { w: window.innerWidth, h: window.innerHeight },
    );
    setMenuPos((prev) => (prev !== null && prev.x === p.x && prev.y === p.y ? prev : p));
  }, [menu]);

  /** 打开内嵌文件夹选择器。 @returns 无 */
  const addProject = (): void => setPicking(true);

  /**
   * 选中目录：加入项目列表并立即切换过去（会话归它管，文件树随之刷新）。
   * @param path 目录路径
   * @returns 无
   */
  const pickProject = async (path: string): Promise<void> => {
    setPicking(false);
    try {
      const res = await api.addWorkspace(path);
      setProjects(res.workspaces);
      await api.switchWorkspace(path);
      setWsPath(path);
      setTreeLoaded(false);
      setTreeError(null);
      onWorkspaceSwitched?.();
    } catch (e) {
      toast('添加失败：' + (e as Error).message, 'err');
    }
  };

  /**
   * 切换项目：服务端重建运行时后刷新文件树；同路径直接短路，不打断用户。
   * @param path 目录路径
   * @returns 无
   */
  const switchProject = async (path: string): Promise<void> => {
    if (path === wsPath) return;
    try {
      await api.switchWorkspace(path);
      setWsPath(path);
      setTreeLoaded(false);
      setTreeError(null);
      onWorkspaceSwitched?.();
    } catch (e) {
      toast('切换失败：' + (e as Error).message, 'err');
    }
  };

  /** 切换视图：时间分组 → 按工作区分组 → 并行任务卡（三态循环）。 @returns 无 */
  const toggleView = (): void => {
    setView((prev) => (prev === 'time' ? 'ws' : prev === 'ws' ? 'cards' : 'time'));
  };

  /**
   * 把某会话钉到列表最前 / 最后（右键菜单「移到顶部 / 移到底部」）。
   *
   * 与拖拽共用同一条通路：`SessionOrder.move` + `props.onReorder` ⇒ 顺序语义、持久化、失败提示
   * 全都一致（不另开一套）。
   * @param id 目标会话 id
   * @param edge 'top' 移到最前、'bottom' 移到最后
   * @returns 无
   */
  const moveToEdge = (id: string, edge: 'top' | 'bottom'): void => {
    if (props.onReorder === undefined) return;
    const first = sessions[0];
    const last = sessions[sessions.length - 1];
    const anchor = edge === 'top' ? first : last;
    if (anchor === undefined || anchor.id === id) return;
    void props.onReorder(SessionOrder.move(sessions, id, anchor.id));
  };

  /** 视图按钮文案（同时作为 aria-label，见下）。 @returns 中文字样 */
  const viewLabel = (): string => (view === 'time' ? '时间' : view === 'ws' ? '工作区' : '任务卡');
  /** 下一个视图的提示文案。 @returns 中文字样 */
  const nextViewTitle = (): string =>
    view === 'time' ? '切换到按工作区分组' : view === 'ws' ? '切换到任务卡视图' : '切换到时间分组';

  /** 进入行内重命名：预填当前标签，并清掉其他行内态。 */
  const startRename = (s: SessionEntry): void => {
    setRenamingId(s.id);
    setRenameValue(s.label || s.id);
    setConfirmDeleteId(null);
  };

  /** 取消行内重命名。 @returns 无 */
  const cancelRename = (): void => {
    setRenamingId(null);
    setRenameValue('');
  };

  /**
   * 提交行内重命名（空标题也照常提交，由服务端清除自定义标题）。
   * @param id 会话 id
   * @returns 无
   */
  const commitRename = async (id: string): Promise<void> => {
    const title = renameValue;
    setRenamingId(null);
    setRenameValue('');
    await onRename(id, title);
  };

  /** 进入删除确认态。 */
  const askDelete = (id: string): void => {
    setConfirmDeleteId(id);
    setRenamingId(null);
  };

  /** 取消删除确认态。 @returns 无 */
  const cancelDelete = (): void => setConfirmDeleteId(null);

  /**
   * 提交删除。
   * @param id 会话 id
   * @returns 无
   */
  const commitDelete = async (id: string): Promise<void> => {
    setConfirmDeleteId(null);
    await onDelete(id);
  };

  /**
   * 打开一条远端命中：会话跳转 / 文件在右侧面板预览，并清空搜索回到上下文。
   * @param hit 命中条目
   * @returns 无
   */
  const openHit = (hit: SearchHit): void => {
    if (hit.kind === 'chat') onSelect(hit.id);
    else onOpenFile(hit.id);
    setQuery('');
    search.setQuery('');
  };

  /**
   * 搜索框输入：更新本地过滤关键字并把（防抖后的）远端搜索交给状态机。
   * @param e 输入事件
   * @returns 无
   */
  const onSearchInput = (e: React.SyntheticEvent): void => {
    const value = (e.target as HTMLInputElement).value;
    setQuery(value);
    search.setQuery(value);
  };

  /**
   * 搜索框键盘：↑/↓ 移动选中、Enter 打开、Esc 清空。
   * @param e 键盘事件
   * @returns 无
   */
  const onSearchKey = (e: React.KeyboardEvent): void => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      search.move(e.key === 'ArrowDown' ? 1 : -1);
      return;
    }
    if (e.key === 'Escape') {
      setQuery('');
      search.setQuery('');
      return;
    }
    if (e.key === 'Enter') {
      const hit = search.selected();
      if (hit !== null) {
        e.preventDefault();
        openHit(hit);
      }
    }
  };

  const rowCtx: RowCtx = {
    renamingId,
    renameValue,
    confirmDeleteId,
    onStartRename: startRename,
    onRenameInput: setRenameValue,
    onCommitRename: (id: string) => void commitRename(id),
    onCancelRename: cancelRename,
    onAskDelete: askDelete,
    onCancelDelete: cancelDelete,
    onCommitDelete: (id: string) => void commitDelete(id),
    onFork: (id: string) => void onFork(id),
    onContextMenu: (id: string, x: number, y: number) => setMenu({ id, x, y }),
    ...(props.onArchive !== undefined ? { onArchive: props.onArchive } : {}),
  };
  const listCtx: ListCtx = {
    ...rowCtx,
    sessions,
    currentThreadId,
    query,
    wsPath,
    collapsed,
    limits,
    onSelect,
    onToggleGroup: (key: string, isCollapsed: boolean) => {
      setCollapsed((prev) => ({ ...prev, [key]: !isCollapsed }));
    },
    onShowAll: (key: string, total: number) => {
      setLimits((prev) => ({ ...prev, [key]: total }));
    },
    draggingId,
    onDragStart: (id: string) => setDraggingId(id),
    onDragEnd: () => setDraggingId(null),
    onDropOn: (id: string) => {
      const from = draggingId;
      setDraggingId(null);
      if (from === null || from === id || props.onReorder === undefined) return;
      void props.onReorder(SessionOrder.move(sessions, from, id));
    },
  };

  const listOpen = query.trim() !== '';
  const wsName = wsPath === '' ? '未选择项目' : PathJoiner.basename(wsPath);
  const menuSession = menu === null ? undefined : sessions.find((s) => s.id === menu.id);
  return (
    <div className={'col left' + (open ? ' open' : '') + (rail ? ' rail' : '')} style={style}>
      {/* 顶部：工作区/项目切换器（Codex 式一等入口）。收成图标条时只留这一个按钮。 */}
      <div className="ws-switch">
        <button
          className="ws-switch-btn"
          title={wsPath || '选择项目'}
          aria-haspopup="menu"
          aria-expanded={wsMenuOpen ? 'true' : 'false'}
          onClick={() => setWsMenuOpen((v) => !v)}
        >
          <span className="ws-switch-icon">📁</span>
          {rail ? null : <span className="ws-switch-name">{wsName}</span>}
          {rail ? null : <span className="ws-caret">▾</span>}
        </button>
        {wsMenuOpen && !rail ? (
          <div className="ws-switch-menu" role="menu">
            {renderProjectsView(projects, wsPath, (p) => {
              setWsMenuOpen(false);
              void switchProject(p);
            })}
            <button
              className="ws-add"
              onClick={() => {
                setWsMenuOpen(false);
                addProject();
              }}
            >
              + 添加项目
            </button>
          </div>
        ) : null}
      </div>
      <div className="col-head">
        <button
          className="sec-toggle"
          aria-expanded={sessionsOpen ? 'true' : 'false'}
          onClick={() => {
            // 收成图标条时，点区块标题的语义是「展开左栏并进入该区块」（否则点了没反应）。
            if (rail) {
              setRail(false);
              setSessionsOpen(true);
              return;
            }
            setSessionsOpen((v) => !v);
          }}
        >
          <span className="ws-caret">{sessionsOpen ? '▾' : '▸'}</span>
          {rail ? null : <span>会话</span>}
        </button>
        {rail ? (
          <button
            className="ws-add"
            title="搜索会话（展开左栏并聚焦搜索框）"
            aria-label="搜索会话"
            onClick={() => {
              setRail(false);
              setSessionsOpen(true);
              window.requestAnimationFrame(() => searchInputRef.current?.focus());
            }}
          >
            🔍
          </button>
        ) : null}
        {rail ? null : (
          <button
            className="ws-add"
            title={nextViewTitle()}
            aria-label={nextViewTitle()}
            onClick={toggleView}
          >
            {viewLabel()}
          </button>
        )}
        <button
          className="ws-add rail-toggle"
          title={rail ? '展开左栏（[）' : '收起左栏（[）'}
          aria-label={rail ? '展开左栏' : '收起左栏'}
          onClick={() => setRail((v) => !v)}
        >
          {rail ? '»' : '«'}
        </button>
      </div>
      {sessionsOpen ? (
        <div className="section">
          <div className="session-toolbar">
            <input
              className="session-search"
              ref={searchInputRef}
              placeholder="搜索会话…"
              value={query}
              spellCheck={false}
              role="combobox"
              aria-label="搜索会话与文件"
              aria-autocomplete="list"
              aria-expanded={listOpen ? 'true' : 'false'}
              aria-controls={SEARCH_LIST_ID}
              aria-activedescendant={hitIndex >= 0 ? 'sr-opt-' + String(hitIndex) : undefined}
              onChange={onSearchInput}
              onKeyDown={onSearchKey}
            />
            <button className="btn primary" onClick={onNew}>
              + 新建
            </button>
            {onToggleScope === undefined ? null : (
              <button
                className={'btn scope-toggle' + (scopeAll === true ? ' active' : '')}
                title={
                  scopeAll === true
                    ? '当前显示**全部项目**的会话（点击只看本项目）'
                    : '当前只显示**本项目**的会话（点击看全部项目）'
                }
                aria-pressed={scopeAll === true ? 'true' : 'false'}
                onClick={onToggleScope}
              >
                {scopeAll === true ? '全部项目' : '本项目'}
              </button>
            )}
          </div>
          <SearchResults
            groups={groups}
            selectedIndex={hitIndex}
            query={query}
            loading={searching}
            onPick={openHit}
          />
          <div
            id="sessions"
            className={draggingId === null ? undefined : 'touch-drag'}
            onPointerDown={onSessionsPointerDown}
            onPointerUp={onSessionsPointerUp}
            onPointerCancel={() => {
              clearTouchTimer();
              touchDragRef.current = null;
              setDraggingId(null);
            }}
          >
            {view === 'cards'
              ? renderCardsView(listCtx)
              : view === 'ws'
                ? renderGroupsView(listCtx)
                : renderTimeGroupsView(listCtx)}
          </div>
        </div>
      ) : null}
      <div className="col-head">
        <button
          className="sec-toggle"
          aria-expanded={treeOpen ? 'true' : 'false'}
          onClick={() => {
            if (rail) {
              setRail(false);
              setTreeOpen(true);
              return;
            }
            setTreeOpen((v) => !v);
          }}
        >
          <span className="ws-caret">{treeOpen ? '▾' : '▸'}</span>
          {rail ? null : <span>文件</span>}
        </button>
      </div>
      {treeOpen ? (
        <div className="section tree">{renderTreeView(tree, treeLoaded, treeError, onOpenFile)}</div>
      ) : null}
      {picking ? (
        <FolderPicker
          api={api}
          onCancel={() => setPicking(false)}
          onPick={(path) => void pickProject(path)}
        />
      ) : null}
      {menu !== null && menuSession !== undefined ? (
        <div
          className="row-menu"
          ref={menuRef}
          style={{
            left: (menuPos?.x ?? menu.x) + 'px',
            top: (menuPos?.y ?? menu.y) + 'px',
            visibility: menuPos === null ? 'hidden' : 'visible',
          }}
          role="menu"
        >
          <button
            role="menuitem"
            onClick={() => {
              setMenu(null);
              onSelect(menu.id);
            }}
          >
            打开
          </button>
          <button
            role="menuitem"
            onClick={() => {
              setMenu(null);
              startRename(menuSession);
            }}
          >
            重命名
          </button>
          <button
            role="menuitem"
            onClick={() => {
              setMenu(null);
              void onFork(menu.id);
            }}
          >
            复制为副本
          </button>
          {/* 排序：不用拖拽也能把会话钉到最前/最后（Codex 式右键菜单的做法）。 */}
          <button
            role="menuitem"
            onClick={() => {
              setMenu(null);
              moveToEdge(menu.id, 'top');
            }}
          >
            移到顶部
          </button>
          <button
            role="menuitem"
            onClick={() => {
              setMenu(null);
              moveToEdge(menu.id, 'bottom');
            }}
          >
            移到底部
          </button>
          <button
            role="menuitem"
            className="danger"
            onClick={() => {
              setMenu(null);
              askDelete(menu.id);
            }}
          >
            删除…
          </button>
        </div>
      ) : null}
    </div>
  );
}
