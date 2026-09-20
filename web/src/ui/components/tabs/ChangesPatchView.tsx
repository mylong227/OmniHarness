// 变更审查视图：patch 的行级渲染（行号 + 行内评论 + 评论草稿）与块级操作按钮。
//
// 从 ChangesTab 抽出（原文件 420 行实现逼近 500 行上限，且这里是纯渲染、无状态）：
// 本模块只依赖传入的 ReviewCtx，不持有任何状态、不做任何 RPC；键盘评审的选中态由调用方给定，
// 故「渲染」与「交互」两侧都能各自单测。
//
// 块级键盘评审（j/k/a/r）的可见锚点：被选中的 `@@` 头挂 `.hunk-head.selected` 与 aria-current，
// 与鼠标点击共用同一条选中通道（点块头即选中，键盘移动即高亮）。

import { React } from '../../deps.js';
import { parseDiffRows, type DiffRow } from '../../textUtils.js';
import { DiffHunkSplitter } from '../../models/DiffHunkSplitter.js';

/** 单文件变更行。 */
export interface ChangeFile {
  path: string;
  status: string;
  additions: number;
  deletions: number;
}

/** 行内评论（changes.comments RPC 返回结构）。 */
export interface DiffComment {
  id: string;
  path: string;
  side: 'old' | 'new';
  line: number;
  text: string;
  ts: string;
}

/** 评论锚点：文件 + 侧别 + 行号。 */
export interface CommentAnchor {
  path: string;
  side: 'old' | 'new';
  line: number;
}

/** 行内审查渲染所需的上下文与回调。 */
export interface ReviewCtx {
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
  /** 键盘评审的选中块序号（-1 表示无选中）。 */
  selected: number;
  /** 选中某个改动块（鼠标点块头与键盘移动共用）。 */
  onSelectHunk: (idx: number) => void;
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
 * 取某改动块的首个改动行锚点（键盘 `c` 评论的落点）。
 * 只认 add / del 行：上下文行评论价值低，且块首往往就是改动行。
 * @param patch 当前 patch 文本
 * @param idx 改动块序号
 * @param path 文件路径（写进锚点，供评论持久化定位）
 * @returns 锚点；该块无改动行（或序号越界）时为 null
 */
export function firstAnchorOfHunk(patch: string, idx: number, path: string): CommentAnchor | null {
  const rows = parseDiffRows(patch);
  let seen = -1;
  for (const row of rows) {
    if (row.kind === 'hunk') {
      seen++;
      continue;
    }
    if (seen !== idx) continue;
    if (row.kind !== 'add' && row.kind !== 'del') continue;
    const { side, line } = anchorOf(row);
    if (line === undefined) continue;
    return { path, side, line };
  }
  return null;
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
          aria-label={'评论第 ' + String(line) + ' 行'}
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
      <button
        className="dc-del"
        title="删除评论"
        aria-label={'删除评论：' + c.text.slice(0, 20)}
        onClick={() => ctx.onDeleteComment(c.id)}
      >
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
        aria-label="行内评论内容"
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
export function renderChangesPatch(ctx: ReviewCtx): ReactElement {
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
      const selected = idx === ctx.selected;
      out.push(
        <div
          key={'h' + i}
          className={'hunk-head' + (selected ? ' selected' : '')}
          data-hunk-idx={String(idx)}
          aria-current={selected ? 'true' : undefined}
          title="点击选中该改动块（键盘 j/k 移动）"
          onClick={() => ctx.onSelectHunk(idx)}
        >
          <span className="hunk-header">{row.text}</span>
          {ctx.isGit && h ? (
            <span className="hunk-actions">
              <button
                className="hunk-btn"
                disabled={ctx.busyAct !== null}
                title="stage 该改动块（git apply --cached）"
                onClick={() =>
                  ctx.onStageHunk(ctx.f.path, DiffHunkSplitter.text(h), isNewFile, idx)
                }
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
