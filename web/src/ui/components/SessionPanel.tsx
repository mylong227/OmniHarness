// 左栏：会话列表 + 新建会话 + 工作区文件树。
//
// 面向对象改造：
// - 服务经 useApp() 取用（替代旧基类访问器），十三份 state 收敛为字段级 useState；
// - 会话分组逻辑下沉到 SessionGrouper（零 React，可单测）；
// - 文件树节点拆为 TreeNode 组件（各自管理展开态）。
//
// 函数组件范式：13 个交互字段各一个 useState；挂载拉工作区 / 依赖 wsPath 重刷文件树
// 各由一个 effect 承接（原实现拆在 componentDidMount + componentDidUpdate）；
// 渲染分支（会话行 / 任务卡 / 分组列表 / 项目条 / 文件树）下沉为模块级纯函数。

import { React } from '../deps.js';
import { useApp } from '../context.js';
import { TreeNode } from './TreeNode.js';
import { FolderPicker } from './FolderPicker.js';
import { SessionGrouper } from '../models/SessionGrouper.js';
import { PathJoiner } from '../models/PathJoiner.js';
import type { FsNode } from '../../types/models.js';
import type { SessionEntry } from '../shared.js';
import { emptyState } from '../format.js';
import { timeAgo } from '../textUtils.js';

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
}

/** 每组默认展示条数。 */
const PAGE = 10;

/** 会话行内交互所需的状态与回调（供模块级渲染函数复用）。 */
interface RowCtx {
  /** 正在行内重命名的会话 id（null 表示无）。 */
  renamingId: string | null;
  /** 行内重命名输入框当前值。 */
  renameValue: string;
  /** 正在确认删除的会话 id（null 表示无）。 */
  confirmDeleteId: string | null;
  onStartRename: (s: SessionEntry) => void;
  onRenameInput: (v: string) => void;
  onCommitRename: (id: string) => void;
  onCancelRename: () => void;
  onAskDelete: (id: string) => void;
  onCancelDelete: () => void;
  onCommitDelete: (id: string) => void;
  onFork: (id: string) => void;
}

/**
 * 按搜索关键字过滤会话（标签 / id / 工作区，大小写不敏感）。
 * @param items 原始会话列表
 * @param query 搜索关键字（trim 后）
 * @returns 过滤后的会话列表（空关键字返回原列表副本）
 */
function filterSessions(items: readonly SessionEntry[], query: string): SessionEntry[] {
  const q = query.trim().toLowerCase();
  if (q === '') return items.slice();
  return items.filter((s) => {
    const hay = [s.label, s.id, s.workspace].filter((x) => typeof x === 'string').join(' ').toLowerCase();
    return hay.includes(q);
  });
}

/**
 * 渲染单条会话的内部内容：常态显示标签 + 操作按钮（重命名/复制/删除）；
 * 行内重命名态显示输入框；删除确认态显示「删除？」确认条。
 * @param s 会话条目
 * @param ctx 行内交互上下文
 * @returns 渲染节点
 */
function renderSessionBody(s: SessionEntry, ctx: RowCtx): ReactElement {
  if (ctx.renamingId === s.id) {
    return (
      <span className="session-rename">
        <input
          className="session-rename-input"
          value={ctx.renameValue}
          spellCheck={false}
          onChange={(e) => ctx.onRenameInput((e.target as HTMLInputElement).value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') ctx.onCommitRename(s.id);
            else if (e.key === 'Escape') ctx.onCancelRename();
          }}
          onClick={(e) => e.stopPropagation()}
        />
        <button
          className="session-rename-ok"
          title="确认"
          onClick={(e) => {
            e.stopPropagation();
            ctx.onCommitRename(s.id);
          }}
        >
          ✓
        </button>
        <button
          className="session-rename-cancel"
          title="取消"
          onClick={(e) => {
            e.stopPropagation();
            ctx.onCancelRename();
          }}
        >
          ✕
        </button>
      </span>
    );
  }
  if (ctx.confirmDeleteId === s.id) {
    return (
      <span className="session-confirm">
        <span className="session-confirm-text">删除？</span>
        <button
          className="session-confirm-ok"
          title="确认删除"
          onClick={(e) => {
            e.stopPropagation();
            ctx.onCommitDelete(s.id);
          }}
        >
          删除
        </button>
        <button
          className="session-confirm-cancel"
          title="取消"
          onClick={(e) => {
            e.stopPropagation();
            ctx.onCancelDelete();
          }}
        >
          取消
        </button>
      </span>
    );
  }
  return (
    <>
      <span className="session-label">{s.label || s.id}</span>
      <span className="session-actions" onClick={(e) => e.stopPropagation()}>
        <button
          className="session-act"
          title="重命名"
          onClick={(e) => {
            e.stopPropagation();
            ctx.onStartRename(s);
          }}
        >
          ✎
        </button>
        <button
          className="session-act"
          title="复制会话"
          onClick={(e) => {
            e.stopPropagation();
            ctx.onFork(s.id);
          }}
        >
          ⧉
        </button>
        <button
          className="session-act danger"
          title="删除"
          onClick={(e) => {
            e.stopPropagation();
            ctx.onAskDelete(s.id);
          }}
        >
          🗑
        </button>
      </span>
    </>
  );
}

/** 列表视图（任务卡 / 分组）渲染所需上下文。 */
interface ListCtx extends RowCtx {
  sessions: SessionEntry[];
  currentThreadId: string | null;
  query: string;
  wsPath: string;
  collapsed: Record<string, boolean>;
  limits: Record<string, number>;
  onSelect: (id: string) => void;
  onToggleGroup: (key: string, isCollapsed: boolean) => void;
  onShowAll: (key: string, total: number) => void;
}

/**
 * 并行任务卡视图：running 徽章来自服务端 activeTurns 真实运行态（非前端猜测）。
 * @param ctx 列表上下文
 * @returns 任务卡列表节点
 */
function renderCardsView(ctx: ListCtx): ReactElement {
  const all = filterSessions(ctx.sessions, ctx.query);
  if (all.length === 0) {
    return emptyState('🗂️', '暂无会话', '新建会话后，任务卡会显示在这里。');
  }
  return (
    <div className="session-cards">
      {all.map((s) => (
        <div
          key={s.id}
          className={
            'task-card' + (s.id === ctx.currentThreadId ? ' active' : '') + (s.running ? ' running' : '')
          }
          title={s.id}
          onClick={() => ctx.onSelect(s.id)}
        >
          <div className="tc-top">
            <span
              className={'tc-dot' + (s.running === true ? ' on' : '')}
              title={s.running ? '运行中' : '空闲'}
            ></span>
            <span className="tc-label">{renderSessionBody(s, ctx)}</span>
          </div>
          <div className="tc-meta">
            <span>{s.turns ?? 0} 回合</span>
            <span>·</span>
            <span>{timeAgo(s.updatedAt)}</span>
            {s.workspace ? (
              <span className="tc-ws" title={s.workspace}>
                {PathJoiner.basename(s.workspace)}
              </span>
            ) : null}
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * 分组列表视图：当前项目组排最前且默认展开，其余折叠；组内分页。
 * @param ctx 列表上下文
 * @returns 分组列表节点
 */
function renderGroupsView(ctx: ListCtx): ReactElement {
  const all = filterSessions(ctx.sessions, ctx.query);
  if (all.length === 0) {
    return emptyState('🗂️', '暂无会话', '新建会话后，历史对话会显示在这里，随时可回看。');
  }
  return (
    <>
      {SessionGrouper.group(all, ctx.wsPath).map((g) => {
        const isCollapsed = ctx.collapsed[g.key] ?? (g.key !== PathJoiner.normalize(ctx.wsPath) && g.key !== '__early__');
        const limit = ctx.limits[g.key] ?? PAGE;
        const shown = isCollapsed ? [] : g.items.slice(0, limit);
        const rest = g.items.length - shown.length;
        return (
          <div className="ws-group" key={g.key}>
            <div
              className="ws-head"
              title={g.key === '__early__' ? '升级前的历史会话未记录所属项目' : g.key}
              onClick={() => ctx.onToggleGroup(g.key, isCollapsed)}
            >
              <span className="ws-caret">{isCollapsed ? '▸' : '▾'}</span>
              <span>{g.key === PathJoiner.normalize(ctx.wsPath) ? '🟢' : '📁'}</span>
              <span className="ws-name">{g.name}</span>
              <span className="ws-count">{g.items.length}</span>
            </div>
            {isCollapsed ? null : (
              <div className="ws-list">
                {shown.map((s) => (
                  <div
                    key={s.id}
                    className={'session' + (s.id === ctx.currentThreadId ? ' active' : '')}
                    onClick={() => ctx.onSelect(s.id)}
                    title={s.id}
                  >
                    {renderSessionBody(s, ctx)}
                  </div>
                ))}
                {rest > 0 ? (
                  <button className="ws-more" onClick={() => ctx.onShowAll(g.key, g.items.length)}>
                    显示全部 {g.items.length} 条
                  </button>
                ) : null}
              </div>
            )}
          </div>
        );
      })}
    </>
  );
}

/**
 * 项目条：列出已添加的项目文件夹，点击切换。
 * @param projects 项目路径清单
 * @param wsPath 当前工作区路径
 * @param onSwitch 切换回调
 * @returns 项目条节点；无项目时为 null
 */
function renderProjectsView(
  projects: string[],
  wsPath: string,
  onSwitch: (path: string) => void,
): ReactElement | null {
  if (projects.length === 0) return null;
  return (
    <div className="ws-projects">
      {projects.map((p) => (
        <div
          key={p}
          className={'ws-project' + (p === wsPath ? ' active' : '')}
          title={p === wsPath ? '当前工作区' : '点击直接切换到 ' + p}
          onClick={() => onSwitch(p)}
        >
          <span className="ws-project-dot"></span>
          <span className="ws-project-name">{PathJoiner.basename(p)}</span>
        </div>
      ))}
    </div>
  );
}

/**
 * 文件树区：按加载态渲染不可用 / 读取中 / 空 / 树。
 * @param tree 文件树
 * @param treeLoaded 是否已加载
 * @param treeError 错误信息（非空即不可用）
 * @param onOpenFile 打开文件回调
 * @returns 文件树区节点
 */
function renderTreeView(
  tree: FsNode[],
  treeLoaded: boolean,
  treeError: string | null,
  onOpenFile: (path: string) => void,
): ReactElement {
  if (treeError != null) {
    return emptyState('📁', '文件树不可用', '当前工作区无法读取，或 serve 未在工作区内启动。');
  }
  if (!treeLoaded) return <div className="empty">读取中…</div>;
  if (tree.length === 0) return emptyState('📁', '空工作区', '这个目录还没有文件。');
  return (
    <div className="tree">
      {tree.map((n) => (
        <TreeNode key={n.path} node={n} onOpenFile={onOpenFile} />
      ))}
    </div>
  );
}

/**
 * 左栏会话与工作区面板：会话列表（列表 / 任务卡视图）、搜索、重命名删除分叉、工作区切换。
 * @param props 组件入参
 * @returns 左栏节点
 */
export function SessionPanel(props: SessionPanelProps): ReactElement {
  const { sessions, currentThreadId, onSelect, onNew, onOpenFile, onRename, onDelete, onFork, onWorkspaceSwitched, open, style } =
    props;
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

  return (
    <div className={'col left' + (open ? ' open' : '')} style={style}>
      <div className="col-head">
        <span>会话</span>
        <button
          className="ws-add"
          title={view === 'list' ? '切换到并行任务卡视图' : '切换到列表视图'}
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
            onChange={(e) => setQuery((e.target as HTMLInputElement).value)}
          />
          <button className="btn primary" onClick={onNew}>
            + 新建
          </button>
        </div>
        <div id="sessions">{view === 'cards' ? renderCardsView(listCtx) : renderGroupsView(listCtx)}</div>
      </div>
      <div className="col-head">
        <span>工作区</span>
        <button className="ws-add" title="添加项目文件夹" onClick={addProject}>
          + 添加项目
        </button>
      </div>
      {renderProjectsView(projects, wsPath, (p) => void switchProject(p))}
      <div className="section tree">{renderTreeView(tree, treeLoaded, treeError, onOpenFile)}</div>
      {picking ? (
        <FolderPicker api={api} onCancel={() => setPicking(false)} onPick={(path) => void pickProject(path)} />
      ) : null}
    </div>
  );
}
