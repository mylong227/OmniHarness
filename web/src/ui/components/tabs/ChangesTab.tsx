// 变更面板（git 式）：拉取 changes.list 展示当前工作区文件变更清单（状态 + 增删行数），
// 点击文件查看 patch。git 仓库用真实 git status/diff；非 git 工作区回退聚合本进程 turn_diff 事件。
// 内联审查（对标 Codex Review）：hunk 级 stage/revert（真实 git apply 操作）+ 行内评论（锚定行持久化）。
//
// 函数组件范式：十份 state 各用 useState；hunk 切分继续复用 DiffHunkSplitter（零 React，可单测）；
// 行 / 评论 / 草稿 / patch 视图下沉为模块级渲染函数（经 ReviewCtx 传参，组件主体只留状态与回调）。

import { React } from '../../deps.js';
import { useApp } from '../../context.js';
import { statusBadge, parseDiffRows, timeAgo, type DiffRow } from '../../textUtils.js';
import { DiffHunkSplitter } from '../../models/DiffHunkSplitter.js';

/** 单文件变更行。 */
interface ChangeFile {
  path: string;
  status: string;
  additions: number;
  deletions: number;
}

/** 变更清单响应。 */
interface ChangesData {
  source: string;
  branch?: string;
  files?: ChangeFile[];
}

/** 行内评论（changes.comments RPC 返回结构）。 */
interface DiffComment {
  id: string;
  path: string;
  side: 'old' | 'new';
  line: number;
  text: string;
  ts: string;
}

/** 评论锚点：文件 + 侧别 + 行号。 */
interface CommentAnchor {
  path: string;
  side: 'old' | 'new';
  line: number;
}

const HEAD_ROW: Record<string, string> = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  marginBottom: '8px',
};
const DIM_TEXT: Record<string, string> = { fontSize: '12px', color: 'var(--dim)' };
const RETRY_BOX: Record<string, string> = { marginTop: '10px' };

/** 行内审查渲染所需的上下文与回调。 */
interface ReviewCtx {
  /** 当前文件。 */
  f: ChangeFile;
  /** 是否 git 工作区（决定是否显示 stage / 丢弃动作）。 */
  isGit: boolean;
  /** 当前 patch 文本。 */
  patch: string;
  /** patch 是否正在加载。 */
  patchLoading: boolean;
  /** 当前文件的行内评论。 */
  fileComments: DiffComment[];
  /** 进行中的审查操作键（防重复点击）。 */
  busyAct: string | null;
  /** 评论草稿锚点。 */
  draft: CommentAnchor | null;
  /** 评论草稿文本。 */
  draftText: string;
  /** stage 整个文件。 */
  onStageFile: (path: string) => void;
  /** 丢弃整个文件改动。 */
  onRevertFile: (path: string) => void;
  /** stage 单个 hunk。 */
  onStageHunk: (path: string, hunk: string, isNew: boolean, idx: number) => void;
  /** 丢弃单个 hunk。 */
  onRevertHunk: (path: string, hunk: string, idx: number) => void;
  /** 在某行开启评论草稿。 */
  onStartDraft: (anchor: CommentAnchor) => void;
  /** 草稿文本变更。 */
  onDraftText: (text: string) => void;
  /** 保存草稿。 */
  onSaveDraft: () => void;
  /** 取消草稿。 */
  onCancelDraft: () => void;
  /** 删除评论。 */
  onDeleteComment: (id: string) => void;
}

/**
 * 行的侧别与行号：删除行锚旧文件，其余锚新文件。
 * @param row diff 行
 * @returns 侧别与行号（无行号时为 undefined）
 */
function anchorOf(row: DiffRow): { side: 'old' | 'new'; line: number | undefined } {
  const side: 'old' | 'new' = row.kind === 'del' ? 'old' : 'new';
  return { side, line: side === 'old' ? row.oldNo : row.newNo };
}

/**
 * 单行渲染：行号 + 符号 + 内容 + 评论入口。
 * @param row diff 行
 * @param i 行下标
 * @param ctx 审查上下文
 * @returns 行节点
 */
function renderRow(row: DiffRow, i: number, ctx: ReviewCtx): ReactElement {
  const { side, line } = anchorOf(row);
  const sign = row.kind === 'add' ? '+' : row.kind === 'del' ? '−' : ' ';
  return (
    <div key={'r' + i} className={'diff-row ' + row.kind}>
      <span className="diff-no">{row.oldNo ?? ''}</span>
      <span className="diff-no">{row.newNo ?? ''}</span>
      <span className="diff-sign">{sign}</span>
      <span className="diff-text">{row.text.slice(1)}</span>
      {ctx.isGit && line !== undefined ? (
        <button
          className="line-cmt"
          title="添加行内评论"
          onClick={() => ctx.onStartDraft({ path: ctx.f.path, side, line })}
        >
          💬
        </button>
      ) : null}
    </div>
  );
}

/**
 * 某行已存的评论气泡。
 * @param c 评论
 * @param ctx 审查上下文
 * @returns 评论节点
 */
function renderComment(c: DiffComment, ctx: ReviewCtx): ReactElement {
  return (
    <div key={'c' + c.id} className="diff-comment">
      <span className="dc-mark">
        💬 {c.side === 'new' ? '新' : '旧'} L{c.line}
      </span>
      <span className="dc-text">{c.text}</span>
      <span className="dc-time">{timeAgo(c.ts)}</span>
      <button className="dc-del" title="删除评论" onClick={() => ctx.onDeleteComment(c.id)}>
        ×
      </button>
    </div>
  );
}

/**
 * 评论草稿输入框（仅在当前锚点行下方渲染）。
 * @param i 行下标
 * @param ctx 审查上下文
 * @returns 草稿节点
 */
function renderDraft(i: number, ctx: ReviewCtx): ReactElement {
  return (
    <div key={'d' + i} className="diff-draft">
      <textarea
        rows={2}
        autoFocus
        placeholder="评论此行（仅自己与团队可见，工作区级持久化）…"
        value={ctx.draftText}
        onInput={(e: Event) => ctx.onDraftText((e.target as HTMLTextAreaElement).value)}
      ></textarea>
      <div className="dd-actions">
        <button
          className="btn primary"
          disabled={ctx.draftText.trim() === ''}
          onClick={ctx.onSaveDraft}
        >
          保存
        </button>
        <button className="btn" onClick={ctx.onCancelDraft}>
          取消
        </button>
      </div>
    </div>
  );
}

/**
 * 单文件展开视图：文件级操作 + hunk 分块 + 行号 + 行内评论。
 * @param ctx 审查上下文
 * @returns 变更内容节点
 */
function renderPatch(ctx: ReviewCtx): ReactElement {
  if (ctx.patchLoading) return <div className="empty">读取中…</div>;
  if (ctx.patch === '')
    return <div className="empty">无 diff 内容（可能是二进制文件或模式变更）</div>;

  const isNewFile = !ctx.patch.includes('@@') || ctx.f.status === '??';
  const hunks = DiffHunkSplitter.split(ctx.patch);
  const rows = parseDiffRows(ctx.patch);
  const out: ReactElement[] = [];
  let hunkIdx = -1;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    if (row.kind === 'meta') {
      out.push(
        <div key={'m' + i} className="diff-meta">
          {row.text}
        </div>,
      );
      continue;
    }
    if (row.kind === 'hunk') {
      hunkIdx++;
      const h = hunks[hunkIdx];
      const idx = hunkIdx;
      out.push(
        <div key={'h' + i} className="hunk-head">
          <span className="hunk-header">{row.text}</span>
          {ctx.isGit && h ? (
            <span className="hunk-actions">
              <button
                className="hunk-btn"
                disabled={ctx.busyAct !== null}
                title="stage 该改动块（git apply --cached）"
                onClick={() => ctx.onStageHunk(ctx.f.path, DiffHunkSplitter.text(h), isNewFile, idx)}
              >
                ＋ stage
              </button>
              <button
                className="hunk-btn danger"
                disabled={ctx.busyAct !== null}
                title="丢弃该改动块（git apply -R，不可恢复）"
                onClick={() => ctx.onRevertHunk(ctx.f.path, DiffHunkSplitter.text(h), idx)}
              >
                ↩ 丢弃
              </button>
            </span>
          ) : null}
        </div>,
      );
      continue;
    }
    out.push(renderRow(row, i, ctx));
    const { side, line } = anchorOf(row);
    const lineComments =
      line === undefined ? [] : ctx.fileComments.filter((c) => c.side === side && c.line === line);
    for (const c of lineComments) out.push(renderComment(c, ctx));
    if (
      ctx.draft !== null &&
      ctx.draft.path === ctx.f.path &&
      ctx.draft.side === side &&
      ctx.draft.line === line
    ) {
      out.push(renderDraft(i, ctx));
    }
  }

  const fileActions = ctx.isGit ? (
    <div className="file-actions">
      <button
        className="hunk-btn"
        disabled={ctx.busyAct !== null}
        title="stage 整个文件（git add）"
        onClick={() => ctx.onStageFile(ctx.f.path)}
      >
        ＋ stage 文件
      </button>
      <button
        className="hunk-btn danger"
        disabled={ctx.busyAct !== null}
        title="丢弃整个文件的工作区改动（不可恢复）"
        onClick={() => ctx.onRevertFile(ctx.f.path)}
      >
        ↩ 丢弃文件
      </button>
    </div>
  ) : null;

  return (
    <div className="review">
      {fileActions}
      <div className="diff-rows">{out}</div>
    </div>
  );
}

/**
 * 变更审查面板：工作区变更清单 + 块级 stage / 丢弃 + 行内评论。
 * @returns 变更面板节点
 */
export function ChangesTab(): ReactElement {
  const { api, toast, dialog } = useApp();
  const [data, setData] = React.useState<ChangesData | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [loaded, setLoaded] = React.useState<boolean>(false);
  /** 展开的文件路径（点击查看 patch）。 */
  const [expanded, setExpanded] = React.useState<string | null>(null);
  const [patch, setPatch] = React.useState<string>('');
  const [patchLoading, setPatchLoading] = React.useState<boolean>(false);
  /** 全部行内评论（工作区级）。 */
  const [comments, setComments] = React.useState<DiffComment[]>([]);
  /** 进行中的审查操作（防重复点击）：`op:path:idx`。 */
  const [busyAct, setBusyAct] = React.useState<string | null>(null);
  /** 行内评论草稿锚点。 */
  const [draft, setDraft] = React.useState<CommentAnchor | null>(null);
  const [draftText, setDraftText] = React.useState<string>('');

  /** 拉取变更清单。 */
  const refresh = async (): Promise<void> => {
    setLoaded(false);
    setError(null);
    try {
      setData(await api.listChanges());
      setLoaded(true);
    } catch (e) {
      setError((e as Error).message);
      setLoaded(true);
    }
  };

  /** 拉取行内评论；失败静默（评论不可用不阻断 diff 展示）。 */
  const refreshComments = async (): Promise<void> => {
    try {
      const r = await api.listDiffComments();
      setComments(r.comments ?? []);
    } catch {
      /* 静默 */
    }
  };

  // 挂载拉取清单与评论（[] 有意：只在进入该页时拉一次）。
  React.useEffect(() => {
    void refresh();
    void refreshComments();
  }, []);

  /**
   * 展开 / 收起某文件的 patch。
   * @param path 文件路径
   */
  const openPatch = async (path: string): Promise<void> => {
    if (expanded === path) {
      setExpanded(null);
      setPatch('');
      return;
    }
    setExpanded(path);
    setPatchLoading(true);
    setPatch('');
    setDraft(null);
    try {
      const r = await api.listChanges(path);
      setPatch(r.patch ?? '');
    } catch (e) {
      setPatch('读取失败：' + (e as Error).message);
    } finally {
      setPatchLoading(false);
    }
  };

  /**
   * 操作后统一刷新：清单 + 当前展开的 patch + 评论。
   * @param path 当前展开的文件路径
   */
  const reloadAfter = async (path: string): Promise<void> => {
    await refresh();
    await refreshComments();
    try {
      const r = await api.listChanges(path);
      setPatch(r.patch ?? '');
    } catch {
      /* patch 刷新失败保留旧内容 */
    }
  };

  /**
   * 统一执行审查动作：置忙 → 执行 → 提示 → 刷新，失败上抛 toast。
   * @param key 忙碌键（防重复点击）
   * @param fn 实际动作
   * @param okMsg 成功提示
   * @param path 受影响文件（用于刷新其 patch）
   */
  const runOp = async (
    key: string,
    fn: () => Promise<unknown>,
    okMsg: string,
    path: string,
  ): Promise<void> => {
    setBusyAct(key);
    try {
      await fn();
      toast(okMsg, 'ok');
      await reloadAfter(path);
    } catch (e) {
      toast((e as Error).message, 'err');
    } finally {
      setBusyAct(null);
    }
  };

  /**
   * stage 整个文件。
   * @param path 文件路径
   */
  const stageFile = (path: string): void => {
    void runOp('sf:' + path, () => api.stageFile(path), '已 stage：' + path, path);
  };

  /**
   * 丢弃整个文件的工作区改动（先经 DialogService 确认）。
   * @param path 文件路径
   */
  const revertFile = async (path: string): Promise<void> => {
    const ok = await dialog.confirm(`丢弃 ${path} 的全部未提交改动？此操作不可恢复。`, {
      title: '丢弃改动',
      confirmLabel: '丢弃',
      danger: true,
    });
    if (!ok) return;
    await runOp('rf:' + path, () => api.revertFile(path), '已还原：' + path, path);
  };

  /**
   * stage 单个 hunk。
   * @param path 文件路径
   * @param hunk hunk 文本
   * @param isNew 是否新文件
   * @param idx hunk 序号
   */
  const stageHunk = (path: string, hunk: string, isNew: boolean, idx: number): void => {
    void runOp(
      'sh:' + path + ':' + idx,
      () => api.stageHunk(path, hunk, isNew),
      '已 stage 该块',
      path,
    );
  };

  /**
   * 丢弃单个 hunk（先经 DialogService 确认）。
   * @param path 文件路径
   * @param hunk hunk 文本
   * @param idx hunk 序号
   */
  const revertHunk = async (path: string, hunk: string, idx: number): Promise<void> => {
    const ok = await dialog.confirm('丢弃该改动块？工作区对应行将被还原。', {
      title: '丢弃改动块',
      confirmLabel: '丢弃',
      danger: true,
    });
    if (!ok) return;
    await runOp('rh:' + path + ':' + idx, () => api.revertHunk(path, hunk), '已还原该块', path);
  };

  /** 保存行内评论草稿。 */
  const saveDraft = async (): Promise<void> => {
    if (!draft || draftText.trim() === '') return;
    try {
      await api.addDiffComment(draft.path, draft.side, draft.line, draftText.trim());
      setDraft(null);
      setDraftText('');
      await refreshComments();
    } catch (e) {
      toast('评论保存失败：' + (e as Error).message, 'err');
    }
  };

  /**
   * 删除行内评论。
   * @param id 评论 id
   */
  const deleteComment = async (id: string): Promise<void> => {
    try {
      await api.deleteDiffComment(id);
      await refreshComments();
    } catch (e) {
      toast('删除失败：' + (e as Error).message, 'err');
    }
  };

  if (!loaded && data === null) return <div className="empty">读取中…</div>;
  if (error !== null) {
    return (
      <div className="empty">
        变更读取失败：{error}
        <div style={RETRY_BOX}>
          <button className="btn" onClick={() => void refresh()}>
            重试
          </button>
        </div>
      </div>
    );
  }

  const files = data?.files ?? [];
  const isGit = data?.source === 'git';
  return (
    <div>
      <div style={HEAD_ROW}>
        <span style={DIM_TEXT}>
          {isGit
            ? `Git 工作区${data?.branch ? ' · ' + data.branch : ''} · 支持块级 stage/丢弃 与 行内评论`
            : '本会话产生的变更（非 git 工作区）'}
        </span>
        <button className="btn" onClick={() => void refresh()}>
          ↻ 刷新
        </button>
      </div>
      {files.length === 0 ? (
        <div className="empty">✨ 没有变更——工作区很干净。改点东西再来看。</div>
      ) : (
        <div className="changes-list">
          {files.map((f) => {
            const badge = statusBadge(f.status);
            const open = expanded === f.path;
            return (
              <div key={f.path} className="change-item">
                <div
                  className="change-row"
                  onClick={() => void openPatch(f.path)}
                  title="点击查看变更内容"
                >
                  <span className={'change-badge ' + badge.cls}>{badge.label}</span>
                  <span className="change-path">{f.path}</span>
                  <span className="change-nums">
                    {f.additions > 0 ? <span className="additions">+{f.additions}</span> : null}
                    {f.deletions > 0 ? <span className="deletions">−{f.deletions}</span> : null}
                  </span>
                  <span className="change-caret">{open ? '▾' : '▸'}</span>
                </div>
                {open ? (
                  <div className="change-patch">
                    {renderPatch({
                      f,
                      isGit,
                      patch,
                      patchLoading,
                      fileComments: comments.filter((c) => c.path === f.path),
                      busyAct,
                      draft,
                      draftText,
                      onStageFile: stageFile,
                      onRevertFile: (p) => void revertFile(p),
                      onStageHunk: stageHunk,
                      onRevertHunk: (p, h, i) => void revertHunk(p, h, i),
                      onStartDraft: (a) => {
                        setDraft(a);
                        setDraftText('');
                      },
                      onDraftText: setDraftText,
                      onSaveDraft: () => void saveDraft(),
                      onCancelDraft: () => setDraft(null),
                      onDeleteComment: (id) => void deleteComment(id),
                    })}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
