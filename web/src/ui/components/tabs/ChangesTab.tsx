// 变更面板（git 式）：拉取 changes.list 展示当前工作区文件变更清单（状态 + 增删行数），
// 点击文件查看 patch。git 仓库用真实 git status/diff；非 git 工作区回退聚合本进程 turn_diff 事件。
// 内联审查（对标 Codex Review）：hunk 级 stage/revert（真实 git apply 操作）+ 行内评论（锚定行持久化）。
// 键盘评审（A1）：j/k（或 ↑/↓）在改动块间移动选中、a 接受（stage）、r 拒绝（revert）、c 评论、? 帮助；
// 焦点在输入框内时一律不响应（判据在 models/ReviewKeyboard，见其文件头注释）。
//
// 函数组件范式：十份 state 各用 useState；hunk 切分继续复用 DiffHunkSplitter（零 React，可单测）；
// 行 / 评论 / 草稿 / patch 视图下沉为 ChangesPatchView 的模块级渲染函数（经 ReviewCtx 传参）。
// 选中序号的**权威副本**在 models/ReviewCursor（state 仅作渲染镜像，理由见该文件）。

import { React } from '../../deps.js';
import { useApp } from '../../context.js';
import { statusBadge } from '../../textUtils.js';
import { DiffHunkSplitter } from '../../models/DiffHunkSplitter.js';
import { ReviewCursor } from '../../models/ReviewCursor.js';
import { ReviewKeyboard } from '../../models/ReviewKeyboard.js';
import type { ReviewKeyLike } from '../../models/ReviewKeyboard.js';
import {
  renderChangesPatch,
  firstAnchorOfHunk,
  type ChangeFile,
  type CommentAnchor,
  type DiffComment,
} from './ChangesPatchView.js';

/** 变更清单响应。 */
interface ChangesData {
  source: string;
  branch?: string;
  files?: ChangeFile[];
}

const HEAD_ROW: Record<string, string> = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  marginBottom: '8px',
};
const DIM_TEXT: Record<string, string> = { fontSize: '12px', color: 'var(--dim)' };
const RETRY_BOX: Record<string, string> = { marginTop: '10px' };

/** 快捷键帮助条目（文案与 ReviewKeyboard 的绑定表同源，改键时一起改）。 */
const KEY_HELP: readonly { readonly keys: string; readonly desc: string }[] = [
  { keys: 'j / ↓', desc: '选中下一个改动块' },
  { keys: 'k / ↑', desc: '选中上一个改动块' },
  { keys: 'a', desc: '接受（stage）选中块' },
  { keys: 'r', desc: '拒绝（丢弃）选中块，需确认' },
  { keys: 'c', desc: '在选中块的首个改动行写评论' },
  { keys: 'Enter', desc: '未展开时打开选中文件' },
  { keys: '?', desc: '开合本帮助 · Esc 关闭' },
];

/**
 * 变更审查面板：工作区变更清单 + 块级 stage / 丢弃 + 行内评论 + 键盘评审。
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
  /** 选中块序号的渲染镜像（权威值在 ReviewCursor）。 */
  const [selected, setSelected] = React.useState<number>(-1);
  /** 快捷键帮助是否展开（渲染镜像）。 */
  const [help, setHelp] = React.useState<boolean>(false);
  /** 键盘评审的根节点：Tab 落点与 keydown 监听都挂在它上面。 */
  const rootRef = React.useRef<HTMLElement | null>(null);
  // 游标跨渲染复用（构造只发生一次，等价 App.ts 的 controllerRef 写法）。
  const cursorRef = React.useRef<ReviewCursor | null>(null);
  if (cursorRef.current === null) cursorRef.current = new ReviewCursor();
  const cursor = cursorRef.current;

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

  // 进入变更页即把焦点交给评审区：Tab 之后 j/k/a/r 才生效，屏幕阅读器也据此定位。
  React.useEffect(() => {
    rootRef.current?.focus();
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

  const files = data?.files ?? [];
  const isGit = data?.source === 'git';
  const openFile = files.find((f) => f.path === expanded) ?? null;
  // 渲染用的选中序号：夹取到当前清单（展开时＝改动块，收起时＝文件）；
  // 走 cursor.sync 而不是就地 clamp——否则渲染显示第 1 块、cursor 还停在 -1，第一次按 j 会「原地不动」。
  const hunkCount = expanded === null ? 0 : DiffHunkSplitter.split(patch).length;
  const selectedView = cursor.sync(expanded === null ? files.length : hunkCount);

  /**
   * 键盘评审：把裸键解析成动作，落到「当前条目清单」（收起时＝文件，展开时＝改动块）上。
   * @param e 键盘事件
   */
  const onReviewKey = (e: KeyboardEvent): void => {
    const action = ReviewKeyboard.resolve(e as unknown as ReviewKeyLike);
    if (action === 'none') return;
    if (action === 'help') {
      setHelp(cursor.toggleHelp());
      return;
    }
    if (action === 'dismiss') {
      cursor.closeHelp();
      setHelp(false);
      return;
    }
    const hunks = expanded === null ? [] : DiffHunkSplitter.split(patch);
    const count = expanded === null ? files.length : hunks.length;
    if (action === 'next' || action === 'prev' || action === 'first' || action === 'last') {
      e.preventDefault();
      setSelected(cursor.move(action, count));
      return;
    }
    if (count === 0) {
      if (action !== 'open') toast('先在列表里展开一个文件，再对改动块操作', 'err');
      return;
    }
    // 序号一律从 cursor 读权威值：state 是渲染镜像，同一帧内连按 j 时它还没更新。
    const idx = ReviewKeyboard.clamp(cursor.at(), count);
    if (action === 'open') {
      if (expanded === null) {
        const target = files[idx];
        if (target) void openPatch(target.path);
      }
      return;
    }
    if (expanded === null || openFile === null) {
      toast('先在列表里展开一个文件，再对改动块操作', 'err');
      return;
    }
    if (!isGit) {
      toast('非 git 工作区不支持 stage / 丢弃 / 行内评论', 'err');
      return;
    }
    const hunk = hunks[idx];
    if (hunk === undefined) return;
    if (action === 'comment') {
      const anchor = firstAnchorOfHunk(patch, idx, openFile.path);
      if (anchor === null) {
        toast('该改动块没有可评论的改动行', 'err');
        return;
      }
      setDraft(anchor);
      setDraftText('');
      return;
    }
    e.preventDefault();
    const hunkText = DiffHunkSplitter.text(hunk);
    const isNewFile = !patch.includes('@@') || openFile.status === '??';
    if (action === 'accept') stageHunk(openFile.path, hunkText, isNewFile, idx);
    else if (action === 'reject') void revertHunk(openFile.path, hunkText, idx);
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

  return (
    <div
      className="review-root"
      data-review-root="1"
      tabIndex={0}
      role="region"
      aria-label="变更审查（键盘：j/k 选择 · a 接受 · r 拒绝 · c 评论 · ? 帮助）"
      ref={rootRef}
      onKeyDown={onReviewKey}
    >
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
      <div className="review-hint">
        键盘：j/k 选择 · a 接受 · r 拒绝 · c 评论 ·{' '}
        <button
          className="rh-toggle"
          aria-expanded={help ? 'true' : 'false'}
          onClick={() => setHelp(cursor.toggleHelp())}
        >
          ? 帮助
        </button>
      </div>
      {help ? (
        <div
          className="review-help"
          data-review-help="1"
          role="dialog"
          aria-modal="false"
          aria-label="变更审查快捷键"
        >
          <div className="rh-head">键盘评审快捷键（输入框内不生效）</div>
          <ul className="rh-list">
            {KEY_HELP.map((k) => (
              <li key={k.keys}>
                <kbd>{k.keys}</kbd>
                <span>{k.desc}</span>
              </li>
            ))}
          </ul>
          <button
            className="btn"
            onClick={() => {
              cursor.closeHelp();
              setHelp(false);
            }}
          >
            关闭（Esc）
          </button>
        </div>
      ) : null}
      {files.length === 0 ? (
        <div className="empty">✨ 没有变更——工作区很干净。改点东西再来看。</div>
      ) : (
        <div className="changes-list">
          {files.map((f) => {
            const badge = statusBadge(f.status);
            const open = expanded === f.path;
            const fileIdx = files.indexOf(f);
            const selectedFile = expanded === null && fileIdx === selectedView;
            return (
              <div key={f.path} className={'change-item' + (selectedFile ? ' selected' : '')}>
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
                    {renderChangesPatch({
                      f,
                      isGit,
                      patch,
                      patchLoading,
                      fileComments: comments.filter((c) => c.path === f.path),
                      busyAct,
                      draft,
                      draftText,
                      selected: selectedView,
                      onSelectHunk: (idx) => setSelected(idx),
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
