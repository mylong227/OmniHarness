// 左栏：会话列表 + 新建会话 + 工作区文件树。
//
// 面向对象改造：
// - 继承 AppComponent（替代 useApp），八份 state 收敛为单一 state 对象；
// - 会话分组逻辑下沉到 SessionGrouper（零 React，可单测）；
// - 文件树节点拆为 TreeNode 类组件（各自管理展开态）。

import { React } from '../deps.js';
import { AppComponent } from '../base/AppComponent.js';
import { TreeNode } from './TreeNode.js';
import { FolderPicker } from './FolderPicker.js';
import { SessionGrouper } from '../models/SessionGrouper.js';
import { PathJoiner } from '../models/PathJoiner.js';
import type { FsNode } from '../../types/models.js';
import type { SessionEntry } from '../shared.js';
import { emptyState } from '../format.js';
import { timeAgo } from '../textUtils.js';

export interface SessionPanelProps {
  sessions: SessionEntry[];
  currentThreadId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  onOpenFile: (path: string) => void;
  /** 切换项目成功后回调（App 刷新会话列表等）。 */
  onWorkspaceSwitched?: () => void;
  open: boolean;
  style?: Record<string, string>;
}

interface SessionPanelState {
  tree: FsNode[];
  treeLoaded: boolean;
  treeError: string | null;
  /** 折叠态：工作区路径 → 是否收起。 */
  collapsed: Record<string, boolean>;
  /** 分页：工作区路径 → 当前显示条数（默认 10，点「更多」全量）。 */
  limits: Record<string, number>;
  /** 当前工作区路径（供分组标题；服务端单工作区，结构按多组预留）。 */
  wsPath: string;
  /** 已添加的项目文件夹列表（workspace.list 维护，点击切换）。 */
  projects: string[];
  picking: boolean;
  /** 会话视图：list = 分组列表（默认） / cards = 并行任务卡（对标 Codex 并行 thread 监督）。 */
  view: 'list' | 'cards';
}

/** 每组默认展示条数。 */
const PAGE = 10;

/** 左栏会话与工作区面板。 */
export class SessionPanel extends AppComponent<SessionPanelProps, SessionPanelState> {
  constructor(props: SessionPanelProps) {
    super(props);
    this.state = {
      tree: [],
      treeLoaded: false,
      treeError: null,
      collapsed: {},
      limits: {},
      wsPath: '',
      projects: [],
      picking: false,
      view: 'list',
    };
  }

  override componentDidMount(): void {
    void this.loadTree();
    this.api
      .listWorkspaces()
      .then((r) => this.setState({ wsPath: r.current, projects: r.workspaces }))
      .catch(() => {
        /* 静默：分组标题退化为通用名 */
      });
  }

  /** 组件保持挂载时，工作区变化也要重刷文件树（原 useEffect 依赖 wsPath）。 */
  override componentDidUpdate(prevProps: SessionPanelProps, prevState: SessionPanelState): void {
    if (prevState.wsPath !== this.state.wsPath) void this.loadTree();
    void prevProps;
  }

  private async loadTree(): Promise<void> {
    try {
      const r = await this.api.listFs(3);
      this.setState({ tree: r.tree || [], treeLoaded: true, treeError: null });
    } catch {
      this.setState({ treeError: '文件树不可用', treeLoaded: true });
    }
  }

  /** 打开内嵌文件夹选择器。 */
  private readonly addProject = (): void => {
    this.setState({ picking: true });
  };

  /** 选中目录：加入项目列表并立即切换过去（会话归它管，文件树随之刷新）。 */
  private readonly pickProject = async (path: string): Promise<void> => {
    this.setState({ picking: false });
    try {
      const res = await this.api.addWorkspace(path);
      this.setState({ projects: res.workspaces });
      await this.api.switchWorkspace(path);
      this.setState({ wsPath: path, treeLoaded: false, treeError: null });
      this.props.onWorkspaceSwitched?.();
    } catch (e) {
      this.toast('添加失败：' + (e as Error).message, 'err');
    }
  };

  /** 切换项目：服务端重建运行时后刷新文件树；同路径直接短路，不打断用户。 */
  private readonly switchProject = async (path: string): Promise<void> => {
    if (path === this.state.wsPath) return;
    try {
      await this.api.switchWorkspace(path);
      this.setState({ wsPath: path, treeLoaded: false, treeError: null });
      this.props.onWorkspaceSwitched?.();
    } catch (e) {
      this.toast('切换失败：' + (e as Error).message, 'err');
    }
  };

  /** 切换视图：分组列表 ⇄ 并行任务卡。 */
  private readonly toggleView = (): void => {
    this.setState((prev) => ({ view: prev.view === 'list' ? 'cards' : 'list' }));
  };

  private renderTree(): ReactElement {
    const { tree, treeLoaded, treeError } = this.state;
    if (treeError != null) {
      return emptyState('📁', '文件树不可用', '当前工作区无法读取，或 serve 未在工作区内启动。');
    }
    if (!treeLoaded) return <div className="empty">读取中…</div>;
    if (tree.length === 0) return emptyState('📁', '空工作区', '这个目录还没有文件。');
    return (
      <div className="tree">
        {tree.map((n) => (
          <TreeNode key={n.path} node={n} onOpenFile={this.props.onOpenFile} />
        ))}
      </div>
    );
  }

  /** 并行任务卡视图：running 徽章来自服务端 activeTurns 真实运行态（非前端猜测）。 */
  private renderCards(): ReactElement {
    const { sessions, currentThreadId, onSelect } = this.props;
    if (sessions.length === 0) {
      return emptyState('🗂️', '暂无会话', '新建会话后，任务卡会显示在这里。');
    }
    return (
      <div className="session-cards">
        {sessions.map((s) => (
          <div
            key={s.id}
            className={
              'task-card' +
              (s.id === currentThreadId ? ' active' : '') +
              (s.running ? ' running' : '')
            }
            title={s.id}
            onClick={() => onSelect(s.id)}
          >
            <div className="tc-top">
              <span
                className={'tc-dot' + (s.running === true ? ' on' : '')}
                title={s.running ? '运行中' : '空闲'}
              ></span>
              <span className="tc-label">{s.label || s.id}</span>
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

  /** 分组列表视图：当前项目组排最前且默认展开，其余折叠；组内分页。 */
  private renderGroups(): ReactElement {
    const { sessions, currentThreadId, onSelect } = this.props;
    const { collapsed, limits, wsPath } = this.state;
    if (sessions.length === 0) {
      return emptyState('🗂️', '暂无会话', '新建会话后，历史对话会显示在这里，随时可回看。');
    }
    return (
      <>
        {SessionGrouper.group(sessions, wsPath).map((g) => {
          const isCollapsed = collapsed[g.key] ?? (g.key !== PathJoiner.normalize(wsPath) && g.key !== '__early__');
          const limit = limits[g.key] ?? PAGE;
          const shown = isCollapsed ? [] : g.items.slice(0, limit);
          const rest = g.items.length - shown.length;
          return (
            <div className="ws-group" key={g.key}>
              <div
                className="ws-head"
                title={g.key === '__early__' ? '升级前的历史会话未记录所属项目' : g.key}
                onClick={() =>
                  this.setState((prev) => ({
                    collapsed: { ...prev.collapsed, [g.key]: !isCollapsed },
                  }))
                }
              >
                <span className="ws-caret">{isCollapsed ? '▸' : '▾'}</span>
                <span>{g.key === PathJoiner.normalize(wsPath) ? '🟢' : '📁'}</span>
                <span className="ws-name">{g.name}</span>
                <span className="ws-count">{g.items.length}</span>
              </div>
              {isCollapsed ? null : (
                <div className="ws-list">
                  {shown.map((s) => (
                    <div
                      key={s.id}
                      className={'session' + (s.id === currentThreadId ? ' active' : '')}
                      onClick={() => onSelect(s.id)}
                      title={s.id}
                    >
                      {s.label || s.id}
                    </div>
                  ))}
                  {rest > 0 ? (
                    <button
                      className="ws-more"
                      onClick={() =>
                        this.setState((prev) => ({
                          limits: { ...prev.limits, [g.key]: g.items.length },
                        }))
                      }
                    >
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

  private renderProjects(): ReactElement | null {
    const { projects, wsPath } = this.state;
    if (projects.length === 0) return null;
    return (
      <div className="ws-projects">
        {projects.map((p) => (
          <div
            key={p}
            className={'ws-project' + (p === wsPath ? ' active' : '')}
            title={p === wsPath ? '当前工作区' : '点击直接切换到 ' + p}
            onClick={() => void this.switchProject(p)}
          >
            <span className="ws-project-dot"></span>
            <span className="ws-project-name">{PathJoiner.basename(p)}</span>
          </div>
        ))}
      </div>
    );
  }

  override render(): ReactElement {
    const { onNew, open, style } = this.props;
    const { view, picking } = this.state;
    return (
      <div className={'col left' + (open ? ' open' : '')} style={style}>
        <div className="col-head">
          <span>会话</span>
          <button
            className="ws-add"
            title={view === 'list' ? '切换到并行任务卡视图' : '切换到列表视图'}
            onClick={this.toggleView}
          >
            {view === 'list' ? '任务卡' : '列表'}
          </button>
        </div>
        <div className="section">
          <button className="btn primary" onClick={onNew}>
            + 新建会话
          </button>
          <div id="sessions">{view === 'cards' ? this.renderCards() : this.renderGroups()}</div>
        </div>
        <div className="col-head">
          <span>工作区</span>
          <button className="ws-add" title="添加项目文件夹" onClick={this.addProject}>
            + 添加项目
          </button>
        </div>
        {this.renderProjects()}
        <div className="section tree">{this.renderTree()}</div>
        {picking ? (
          <FolderPicker
            api={this.api}
            onCancel={() => this.setState({ picking: false })}
            onPick={(path) => void this.pickProject(path)}
          />
        ) : null}
      </div>
    );
  }
}
