// 左栏的模块级渲染函数：会话行 / 任务卡视图 / 分组列表视图 / 项目条 / 文件树。
//
// 从 SessionPanel 抽出（原文件 457 行实现逼近 500 行上限，且这里全是纯渲染、无状态）：
// 每个函数只吃一个 ctx（状态 + 回调），不持有任何状态、不发任何请求，故可被 SessionPanel
// 与将来任何宿主复用；会话过滤（filterSessions）也在此，供本地即时过滤与单测共用。

import { React } from '../deps.js';
import { TreeNode } from './TreeNode.js';
import { SessionGrouper } from '../models/SessionGrouper.js';
import { PathJoiner } from '../models/PathJoiner.js';
import type { FsNode } from '../../types/models.js';
import type { SessionEntry } from '../shared.js';
import { emptyState } from '../format.js';
import { timeAgo } from '../textUtils.js';

/** 每组默认展示条数。 */
export const PAGE = 10;

/** 会话行内交互所需的状态与回调（供模块级渲染函数复用）。 */
export interface RowCtx {
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

/** 列表视图（任务卡 / 分组）渲染所需上下文。 */
export interface ListCtx extends RowCtx {
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
 * 按搜索关键字过滤会话（标签 / id / 工作区，大小写不敏感）。
 * @param items 原始会话列表
 * @param query 搜索关键字（trim 后）
 * @returns 过滤后的会话列表（空关键字返回原列表副本）
 */
export function filterSessions(items: readonly SessionEntry[], query: string): SessionEntry[] {
  const q = query.trim().toLowerCase();
  if (q === '') return items.slice();
  return items.filter((s) => {
    const hay = [s.label, s.id, s.workspace]
      .filter((x) => typeof x === 'string')
      .join(' ')
      .toLowerCase();
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
export function renderSessionBody(s: SessionEntry, ctx: RowCtx): ReactElement {
  if (ctx.renamingId === s.id) {
    return (
      <span className="session-rename">
        <input
          className="session-rename-input"
          value={ctx.renameValue}
          spellCheck={false}
          aria-label="会话标题"
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
          aria-label="确认重命名"
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
          aria-label="取消重命名"
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
          aria-label={'确认删除会话 ' + (s.label || s.id)}
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
          aria-label="取消删除"
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
          aria-label={'重命名会话 ' + (s.label || s.id)}
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
          aria-label={'复制会话 ' + (s.label || s.id)}
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
          aria-label={'删除会话 ' + (s.label || s.id)}
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

/**
 * 并行任务卡视图：running 徽章来自服务端 activeTurns 真实运行态（非前端猜测）。
 * @param ctx 列表上下文
 * @returns 任务卡列表节点
 */
export function renderCardsView(ctx: ListCtx): ReactElement {
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
            'task-card' +
            (s.id === ctx.currentThreadId ? ' active' : '') +
            (s.running ? ' running' : '')
          }
          title={s.id}
          onClick={() => ctx.onSelect(s.id)}
        >
          <div className="tc-top">
            <span
              className={'tc-dot' + (s.running === true ? ' on' : '')}
              title={s.running ? '运行中' : '空闲'}
              aria-hidden="true"
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
export function renderGroupsView(ctx: ListCtx): ReactElement {
  const all = filterSessions(ctx.sessions, ctx.query);
  if (all.length === 0) {
    return emptyState('🗂️', '暂无会话', '新建会话后，历史对话会显示在这里，随时可回看。');
  }
  return (
    <>
      {SessionGrouper.group(all, ctx.wsPath).map((g) => {
        const isCollapsed =
          ctx.collapsed[g.key] ??
          (g.key !== PathJoiner.normalize(ctx.wsPath) && g.key !== '__early__');
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
export function renderProjectsView(
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
          <span className="ws-project-dot" aria-hidden="true"></span>
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
export function renderTreeView(
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
