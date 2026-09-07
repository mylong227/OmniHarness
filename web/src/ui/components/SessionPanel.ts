// 左栏：会话列表 + 新建会话 + 工作区文件树。文件树用递归 TreeNode 子组件管理各自展开态。

import { html, React } from '../deps.js';
import { useApp } from '../context.js';
import type { FsNode } from '../../types/models.js';
import type { SessionEntry } from '../shared.js';
import { emptyState } from '../format.js';
import { FolderPicker } from './FolderPicker.js';

function TreeNode(props: { node: FsNode; onOpenFile: (path: string) => void }): ReactElement {
  const { node, onOpenFile } = props;
  const [open, setOpen] = React.useState(false);
  if (node.type === 'dir') {
    const children = open ? node.children || [] : [];
    return html`<div className=${'node dir' + (open ? ' open' : '')}>
      <span className="label" onClick=${() => setOpen((o) => !o)}>${node.name}</span>
      <div className="children">
        ${children.map((c) => html`<${TreeNode} key=${c.path} node=${c} onOpenFile=${onOpenFile} />`)}
      </div>
    </div>`;
  }
  return html`<div className="node file">
    <span className="label" onClick=${() => onOpenFile(node.path)}>${node.name}</span>
  </div>`;
}

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

export function SessionPanel(props: SessionPanelProps): ReactElement {
  const { sessions, currentThreadId, onSelect, onNew, onOpenFile, onWorkspaceSwitched, open, style } = props;
  const { api } = useApp();
  const [tree, setTree] = React.useState<FsNode[]>([]);
  const [treeLoaded, setTreeLoaded] = React.useState(false);
  const [treeError, setTreeError] = React.useState<string | null>(null);
  /** 折叠态：工作区路径 → 是否收起。 */
  const [collapsed, setCollapsed] = React.useState<Record<string, boolean>>({});
  /** 分页：工作区路径 → 当前显示条数（默认 10，点「更多」全量）。 */
  const PAGE = 10;
  const [limits, setLimits] = React.useState<Record<string, number>>({});
  /** 当前工作区路径（供分组标题；服务端单工作区，结构按多组预留）。 */
  const [wsPath, setWsPath] = React.useState<string>('');
  /** 已添加的项目文件夹列表（workspace.list 维护，点击切换）。 */
  const [projects, setProjects] = React.useState<string[]>([]);
  const [picking, setPicking] = React.useState(false);

  React.useEffect(() => {
    api
      .listFs(3)
      .then((r) => {
        setTree(r.tree || []);
        setTreeLoaded(true);
      })
      .catch(() => {
        setTreeError('文件树不可用');
        setTreeLoaded(true);
      });
  }, [api, wsPath]);

  /** 添加项目：打开内嵌文件夹选择器（服务端 fs.browse 列目录，选中即真实绝对路径）。 */
  const addProject = React.useCallback(async () => {
    setPicking(true);
  }, []);
  const pickProject = React.useCallback(
    async (path: string) => {
      setPicking(false);
      try {
        const res = await api.addWorkspace(path);
        setProjects(res.workspaces);
        // 添加后立即切换到该项目：当前会话归它管，工作区文件树也刷新。
        await api.switchWorkspace(path);
        setTreeLoaded(false);
        setTreeError(null);
        setWsPath(path);
        onWorkspaceSwitched?.();
      } catch (e) {
        window.alert('添加失败：' + (e as Error).message);
      }
    },
    [api, onWorkspaceSwitched],
  );

  /** 切换项目：服务端重建运行时，刷新文件树与当前路径；直接切换不打断（无确认弹框）。 */
  const switchProject = React.useCallback(
    async (path: string) => {
      if (path === wsPath) return;
      try {
        await api.switchWorkspace(path);
        setTreeLoaded(false);
        setTreeError(null);
        setWsPath(path);
        onWorkspaceSwitched?.();
      } catch (e) {
        window.alert('切换失败：' + (e as Error).message);
      }
    },
    [api, wsPath, onWorkspaceSwitched],
  );

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

  const treeView =
    treeError != null
      ? emptyState('📁', '文件树不可用', '当前工作区无法读取，或 serve 未在工作区内启动。')
      : !treeLoaded
        ? html`<div className="empty">读取中…</div>`
        : tree.length === 0
          ? emptyState('📁', '空工作区', '这个目录还没有文件。')
          : html`<div className="tree">
              ${tree.map((n) => html`<${TreeNode} key=${n.path} node=${n} onOpenFile=${onOpenFile} />`)}
            </div>`;

  // 会话按项目分组（session_meta 的工作区标记）：当前项目组排最前且默认展开，
  // 其余项目组默认收起（点击组头展开，切换项目即可查看该项目下的全部会话）；
  // 无标记的历史会话归入「更早会话」组。组内分页（默认 10 条 + 显示全部）。
  const basename = (p: string): string => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? p;
  const currentKey = wsPath ? wsPath.replace(/[\\/]+$/, '') : '';
  const grouped: { key: string; name: string; items: SessionEntry[] }[] = [];
  const byKey = new Map<string, SessionEntry[]>();
  for (const s of sessions) {
    const key = s.workspace ? s.workspace.replace(/[\\/]+$/, '') : '__early__';
    const list = byKey.get(key) ?? [];
    list.push(s);
    byKey.set(key, list);
  }
  const orderedKeys = [
    ...(currentKey !== '' && byKey.has(currentKey) ? [currentKey] : []),
    ...[...byKey.keys()].filter((k) => k !== currentKey && k !== '__early__'),
    ...(byKey.has('__early__') ? ['__early__'] : []),
  ];
  for (const key of orderedKeys) {
    grouped.push({
      key,
      name: key === '__early__' ? '更早会话（未标记项目）' : basename(key),
      items: byKey.get(key) ?? [],
    });
  }

  const sessionsView =
    sessions.length === 0
      ? emptyState('🗂️', '暂无会话', '新建会话后，历史对话会显示在这里，随时可回看。')
      : grouped.map(
          (g) => {
            const isCollapsed = collapsed[g.key] ?? (g.key !== currentKey && g.key !== '__early__');
            const limit = limits[g.key] ?? PAGE;
            const shown = isCollapsed ? [] : g.items.slice(0, limit);
            const rest = g.items.length - shown.length;
            return html`<div className="ws-group" key=${g.key}>
              <div
                className="ws-head"
                title=${g.key === '__early__' ? '升级前的历史会话未记录所属项目' : g.key}
                onClick=${() => setCollapsed((c) => ({ ...c, [g.key]: !(isCollapsed ?? false) }))}
              >
                <span className="ws-caret">${isCollapsed ? '▸' : '▾'}</span>
                <span>${g.key === currentKey ? '🟢' : '📁'}</span>
                <span className="ws-name">${g.name}</span>
                <span className="ws-count">${g.items.length}</span>
              </div>
              ${isCollapsed
                ? null
                : html`<div className="ws-list">
                    ${shown.map(
                      (s) =>
                        html`<div
                          key=${s.id}
                          className=${'session' + (s.id === currentThreadId ? ' active' : '')}
                          onClick=${() => onSelect(s.id)}
                          title=${s.id}
                        >
                          ${s.label || s.id}
                        </div>`,
                    )}
                    ${rest > 0
                      ? html`<button
                          className="ws-more"
                          onClick=${() => setLimits((l) => ({ ...l, [g.key]: g.items.length }))}
                        >显示全部 ${g.items.length} 条</button>`
                      : null}
                  </div>`}
            </div>`;
          },
        );

  return html`<div className=${'col left' + (open ? ' open' : '')} style=${style}>
    <div className="col-head">会话</div>
    <div className="section">
      <button className="btn primary" onClick=${onNew}>+ 新建会话</button>
      <div id="sessions">${sessionsView}</div>
    </div>
    <div className="col-head">
      <span>工作区</span>
      <button className="ws-add" title="添加项目文件夹" onClick=${addProject}>+ 添加项目</button>
    </div>
    ${projects.length > 0
      ? html`<div className="ws-projects">
          ${projects.map(
            (p) => html`<div
              key=${p}
              className=${'ws-project' + (p === wsPath ? ' active' : '')}
              title=${p === wsPath ? '当前工作区' : '点击直接切换到 ' + p}
              onClick=${() => switchProject(p)}
            >
              <span className="ws-project-dot"></span>
              <span className="ws-project-name">${p.replace(/[\\/]+$/, '').split(/[\\/]/).pop()}</span>
            </div>`,
          )}
        </div>`
      : null}
    <div className="section tree">${treeView}</div>
    ${picking ? html`<${FolderPicker} api=${api} onCancel=${() => setPicking(false)} onPick=${pickProject} />` : null}
  </div>`;
}
