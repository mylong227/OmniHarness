// 变更面板（git 式）：拉取 changes.list 展示当前工作区文件变更清单（状态 + 增删行数），
// 点击文件查看 patch。git 仓库用真实 git status/diff；非 git 工作区回退聚合本进程 turn_diff 事件。
// 内联审查（对标 Codex Review）：hunk 级 stage/revert（真实 git apply 操作）+ 行内评论（锚定行持久化）。
//
// 面向对象改造：继承 AppComponent（替代 useApp）；九份 state 收敛为单一 state 对象；
// hunk 切分下沉到 DiffHunkSplitter（零 React，可单测）；行渲染拆为私有方法。

import { React } from '../../deps.js';
import { AppComponent } from '../../base/AppComponent.js';
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

interface ChangesTabState {
  data: ChangesData | null;
  error: string | null;
  loaded: boolean;
  /** 展开的文件路径（点击查看 patch）。 */
  expanded: string | null;
  patch: string;
  patchLoading: boolean;
  /** 全部行内评论（工作区级）。 */
  comments: DiffComment[];
  /** 进行中的审查操作（防重复点击）：`op:path:idx`。 */
  busyAct: string | null;
  /** 行内评论草稿锚点。 */
  draft: CommentAnchor | null;
  draftText: string;
}

const HEAD_ROW: Record<string, string> = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  marginBottom: '8px',
};
const DIM_TEXT: Record<string, string> = { fontSize: '12px', color: 'var(--dim)' };
const RETRY_BOX: Record<string, string> = { marginTop: '10px' };

/** 变更审查面板。 */
export class ChangesTab extends AppComponent<Record<string, never>, ChangesTabState> {
  constructor(props: Record<string, never>) {
    super(props);
    this.state = {
      data: null,
      error: null,
      loaded: false,
      expanded: null,
      patch: '',
      patchLoading: false,
      comments: [],
      busyAct: null,
      draft: null,
      draftText: '',
    };
  }

  override componentDidMount(): void {
    void this.refresh();
    void this.refreshComments();
  }

  /** 拉取变更清单。 */
  private async refresh(): Promise<void> {
    this.setState({ loaded: false, error: null });
    try {
      this.setState({ data: await this.api.listChanges(), loaded: true });
    } catch (e) {
      this.setState({ error: (e as Error).message, loaded: true });
    }
  }

  /** 拉取行内评论；失败静默（评论不可用不阻断 diff 展示）。 */
  private async refreshComments(): Promise<void> {
    try {
      const r = await this.api.listDiffComments();
      this.setState({ comments: r.comments ?? [] });
    } catch {
      /* 静默 */
    }
  }

  /** 展开 / 收起某文件的 patch。 */
  private async openPatch(path: string): Promise<void> {
    if (this.state.expanded === path) {
      this.setState({ expanded: null, patch: '' });
      return;
    }
    this.setState({ expanded: path, patchLoading: true, patch: '', draft: null });
    try {
      const r = await this.api.listChanges(path);
      this.setState({ patch: r.patch ?? '' });
    } catch (e) {
      this.setState({ patch: '读取失败：' + (e as Error).message });
    } finally {
      this.setState({ patchLoading: false });
    }
  }

  /** 操作后统一刷新：清单 + 当前展开的 patch + 评论。 */
  private async reloadAfter(path: string): Promise<void> {
    await this.refresh();
    await this.refreshComments();
    try {
      const r = await this.api.listChanges(path);
      this.setState({ patch: r.patch ?? '' });
    } catch {
      /* patch 刷新失败保留旧内容 */
    }
  }

  /** 统一执行审查动作：置忙 → 执行 → 提示 → 刷新，失败上抛 toast。 */
  private async runOp(key: string, fn: () => Promise<unknown>, okMsg: string, path: string): Promise<void> {
    this.setState({ busyAct: key });
    try {
      await fn();
      this.toast(okMsg, 'ok');
      await this.reloadAfter(path);
    } catch (e) {
      this.toast((e as Error).message, 'err');
    } finally {
      this.setState({ busyAct: null });
    }
  }

  private stageFile(path: string): void {
    void this.runOp('sf:' + path, () => this.api.stageFile(path), '已 stage：' + path, path);
  }

  private async revertFile(path: string): Promise<void> {
    const ok = await this.dialog.confirm(`丢弃 ${path} 的全部未提交改动？此操作不可恢复。`, {
      title: '丢弃改动',
      confirmLabel: '丢弃',
      danger: true,
    });
    if (!ok) return;
    await this.runOp('rf:' + path, () => this.api.revertFile(path), '已还原：' + path, path);
  }

  private stageHunk(path: string, hunk: string, isNew: boolean, idx: number): void {
    void this.runOp(
      'sh:' + path + ':' + idx,
      () => this.api.stageHunk(path, hunk, isNew),
      '已 stage 该块',
      path,
    );
  }

  private async revertHunk(path: string, hunk: string, idx: number): Promise<void> {
    const ok = await this.dialog.confirm('丢弃该改动块？工作区对应行将被还原。', {
      title: '丢弃改动块',
      confirmLabel: '丢弃',
      danger: true,
    });
    if (!ok) return;
    await this.runOp('rh:' + path + ':' + idx, () => this.api.revertHunk(path, hunk), '已还原该块', path);
  }

  private async saveDraft(): Promise<void> {
    const { draft, draftText } = this.state;
    if (!draft || draftText.trim() === '') return;
    try {
      await this.api.addDiffComment(draft.path, draft.side, draft.line, draftText.trim());
      this.setState({ draft: null, draftText: '' });
      await this.refreshComments();
    } catch (e) {
      this.toast('评论保存失败：' + (e as Error).message, 'err');
    }
  }

  private async deleteComment(id: string): Promise<void> {
    try {
      await this.api.deleteDiffComment(id);
      await this.refreshComments();
    } catch (e) {
      this.toast('删除失败：' + (e as Error).message, 'err');
    }
  }

  /** 行的侧别与行号：删除行锚旧文件，其余锚新文件。 */
  private anchorOf(row: DiffRow): { side: 'old' | 'new'; line: number | undefined } {
    const side: 'old' | 'new' = row.kind === 'del' ? 'old' : 'new';
    return { side, line: side === 'old' ? row.oldNo : row.newNo };
  }

  /** 单行渲染：行号 + 符号 + 内容 + 评论入口。 */
  private renderRow(row: DiffRow, i: number, f: ChangeFile, isGit: boolean): ReactElement {
    const { side, line } = this.anchorOf(row);
    const sign = row.kind === 'add' ? '+' : row.kind === 'del' ? '−' : ' ';
    return (
      <div key={'r' + i} className={'diff-row ' + row.kind}>
        <span className="diff-no">{row.oldNo ?? ''}</span>
        <span className="diff-no">{row.newNo ?? ''}</span>
        <span className="diff-sign">{sign}</span>
        <span className="diff-text">{row.text.slice(1)}</span>
        {isGit && line !== undefined ? (
          <button
            className="line-cmt"
            title="添加行内评论"
            onClick={() => this.setState({ draft: { path: f.path, side, line }, draftText: '' })}
          >
            💬
          </button>
        ) : null}
      </div>
    );
  }

  /** 某行已存的评论气泡。 */
  private renderComment(c: DiffComment): ReactElement {
    return (
      <div key={'c' + c.id} className="diff-comment">
        <span className="dc-mark">
          💬 {c.side === 'new' ? '新' : '旧'} L{c.line}
        </span>
        <span className="dc-text">{c.text}</span>
        <span className="dc-time">{timeAgo(c.ts)}</span>
        <button className="dc-del" title="删除评论" onClick={() => void this.deleteComment(c.id)}>
          ×
        </button>
      </div>
    );
  }

  /** 评论草稿输入框（仅在当前锚点行下方渲染）。 */
  private renderDraft(i: number): ReactElement {
    const { draftText } = this.state;
    return (
      <div key={'d' + i} className="diff-draft">
        <textarea
          rows={2}
          autoFocus
          placeholder="评论此行（仅自己与团队可见，工作区级持久化）…"
          value={draftText}
          onInput={(e: Event) =>
            this.setState({ draftText: (e.target as HTMLTextAreaElement).value })
          }
        ></textarea>
        <div className="dd-actions">
          <button
            className="btn primary"
            disabled={draftText.trim() === ''}
            onClick={() => void this.saveDraft()}
          >
            保存
          </button>
          <button className="btn" onClick={() => this.setState({ draft: null })}>
            取消
          </button>
        </div>
      </div>
    );
  }

  /** 单文件展开视图：文件级操作 + hunk 分块 + 行号 + 行内评论。 */
  private renderPatch(f: ChangeFile, isGit: boolean): ReactElement {
    const { patch, patchLoading, comments, busyAct, draft } = this.state;
    if (patchLoading) return <div className="empty">读取中…</div>;
    if (patch === '') return <div className="empty">无 diff 内容（可能是二进制文件或模式变更）</div>;

    const isNewFile = !patch.includes('@@') || f.status === '??';
    const hunks = DiffHunkSplitter.split(patch);
    const rows = parseDiffRows(patch);
    const fileComments = comments.filter((c) => c.path === f.path);
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
            {isGit && h ? (
              <span className="hunk-actions">
                <button
                  className="hunk-btn"
                  disabled={busyAct !== null}
                  title="stage 该改动块（git apply --cached）"
                  onClick={() => this.stageHunk(f.path, DiffHunkSplitter.text(h), isNewFile, idx)}
                >
                  ＋ stage
                </button>
                <button
                  className="hunk-btn danger"
                  disabled={busyAct !== null}
                  title="丢弃该改动块（git apply -R，不可恢复）"
                  onClick={() => void this.revertHunk(f.path, DiffHunkSplitter.text(h), idx)}
                >
                  ↩ 丢弃
                </button>
              </span>
            ) : null}
          </div>,
        );
        continue;
      }
      out.push(this.renderRow(row, i, f, isGit));
      const { side, line } = this.anchorOf(row);
      const lineComments =
        line === undefined ? [] : fileComments.filter((c) => c.side === side && c.line === line);
      for (const c of lineComments) out.push(this.renderComment(c));
      if (draft !== null && draft.path === f.path && draft.side === side && draft.line === line) {
        out.push(this.renderDraft(i));
      }
    }

    const fileActions = isGit ? (
      <div className="file-actions">
        <button
          className="hunk-btn"
          disabled={busyAct !== null}
          title="stage 整个文件（git add）"
          onClick={() => this.stageFile(f.path)}
        >
          ＋ stage 文件
        </button>
        <button
          className="hunk-btn danger"
          disabled={busyAct !== null}
          title="丢弃整个文件的工作区改动（不可恢复）"
          onClick={() => void this.revertFile(f.path)}
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

  override render(): ReactElement {
    const { data, error, loaded, expanded } = this.state;
    if (!loaded && data === null) return <div className="empty">读取中…</div>;
    if (error !== null) {
      return (
        <div className="empty">
          变更读取失败：{error}
          <div style={RETRY_BOX}>
            <button className="btn" onClick={() => void this.refresh()}>
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
          <button className="btn" onClick={() => void this.refresh()}>
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
                    onClick={() => void this.openPatch(f.path)}
                    title="点击查看变更内容"
                  >
                    <span className={'change-badge ' + badge.cls}>{badge.label}</span>
                    <span className="change-path">{f.path}</span>
                    <span className="change-nums">
                      {f.additions > 0 ? (
                        <span className="additions">+{f.additions}</span>
                      ) : null}
                      {f.deletions > 0 ? (
                        <span className="deletions">−{f.deletions}</span>
                      ) : null}
                    </span>
                    <span className="change-caret">{open ? '▾' : '▸'}</span>
                  </div>
                  {open ? (
                    <div className="change-patch">{this.renderPatch(f, isGit)}</div>
                  ) : null}
                </div>
              );
            })}
          </div>
        )}
      </div>
    );
  }
}
