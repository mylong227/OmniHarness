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
  renderTreeView,
} from './SessionViews.js';
import type { ListCtx, RowCtx } from './SessionViews.js';
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
  /** 切换项目成功后回调（App 刷新会话列表等）。 */
  onWorkspaceSwitched?: () => void;
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
  const [view, setView] = React.useState<'list' | 'cards'>('list');
  const [query, setQuery] = React.useState<string>('');
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

  /** 切换视图：分组列表 ⇄ 并行任务卡。 @returns 无 */
  const toggleView = (): void => setView((prev) => (prev === 'list' ? 'cards' : 'list'));

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
  const onSearchInput = (e: Event): void => {
    const value = (e.target as HTMLInputElement).value;
    setQuery(value);
    search.setQuery(value);
  };

  /**
   * 搜索框键盘：↑/↓ 移动选中、Enter 打开、Esc 清空。
   * @param e 键盘事件
   * @returns 无
   */
  const onSearchKey = (e: KeyboardEvent): void => {
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
  };

  const listOpen = query.trim() !== '';
  return (
    <div className={'col left' + (open ? ' open' : '')} style={style}>
      <div className="col-head">
        <span>会话</span>
        <button
          className="ws-add"
          title={view === 'list' ? '切换到并行任务卡视图' : '切换到列表视图'}
          aria-label={view === 'list' ? '切换到任务卡视图' : '切换到列表视图'}
          onClick={toggleView}
        >
          {view === 'list' ? '任务卡' : '列表'}
        </button>
      </div>
      <div className="section">
        <div className="session-toolbar">
          <input
            className="session-search"
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
        </div>
        <SearchResults
          groups={groups}
          selectedIndex={hitIndex}
          query={query}
          loading={searching}
          onPick={openHit}
        />
        <div id="sessions">
          {view === 'cards' ? renderCardsView(listCtx) : renderGroupsView(listCtx)}
        </div>
      </div>
      <div className="col-head">
        <span>工作区</span>
        <button
          className="ws-add"
          title="添加项目文件夹"
          aria-label="添加项目文件夹"
          onClick={addProject}
        >
          + 添加项目
        </button>
      </div>
      {renderProjectsView(projects, wsPath, (p) => void switchProject(p))}
      <div className="section tree">{renderTreeView(tree, treeLoaded, treeError, onOpenFile)}</div>
      {picking ? (
        <FolderPicker
          api={api}
          onCancel={() => setPicking(false)}
          onPick={(path) => void pickProject(path)}
        />
      ) : null}
    </div>
  );
}
