// 变更审查的全部状态与动作：从 ChangesTab 抽出（S2 长函数清偿，2026-11-02）。
//
// 拆成「清单 / patch / 评论 / 审查动作 / 键盘游标」五个内聚 hook，再由 useChangesReview 组合。
// 这样每个函数体都守在 80 行内（check.mjs 口径），组件层只负责渲染。
// 游标权威副本仍在 models/ReviewCursor（state 仅作重渲染镜像），语义与原实现逐条一致。

import * as React from 'react';
import { useApp } from '../../context.ts';
import { DiffHunkSplitter } from '../../models/DiffHunkSplitter.ts';
import { ReviewCursor } from '../../models/ReviewCursor.ts';
import { ReviewKeyboard } from '../../models/ReviewKeyboard.ts';
import type { ReviewKeyLike } from '../../models/ReviewKeyboard.ts';
import {
  firstAnchorOfHunk,
  type ChangeFile,
  type CommentAnchor,
  type DiffComment,
} from './ChangesPatchView.tsx';
import { t } from '../../i18n/i18n.ts';
import type { ApiClient } from '../../../core/ApiClient.ts';
import type { DialogService } from '../../../core/DialogService.ts';

/** 变更清单响应。 */
export interface ChangesData {
  source: string;
  branch?: string;
  files?: ChangeFile[];
}

/** 清单 + patch + 评论 + 审查动作 + 键盘游标的组合视图。 */
export interface ChangesReview {
  data: ChangesData | null;
  error: string | null;
  loaded: boolean;
  files: readonly ChangeFile[];
  isGit: boolean;
  expanded: string | null;
  patch: string;
  patchLoading: boolean;
  openFile: ChangeFile | null;
  comments: DiffComment[];
  busyAct: string | null;
  draft: CommentAnchor | null;
  draftText: string;
  help: boolean;
  selectedView: number;
  rootRef: React.RefObject<HTMLDivElement | null>;
  refresh: () => Promise<void>;
  openPatch: (path: string) => Promise<void>;
  stageFile: (path: string) => void;
  revertFile: (path: string) => Promise<void>;
  stageHunk: (path: string, hunk: string, isNew: boolean, idx: number) => void;
  revertHunk: (path: string, hunk: string, idx: number) => Promise<void>;
  saveDraft: () => Promise<void>;
  deleteComment: (id: string) => Promise<void>;
  setHelp: (value: boolean) => void;
  toggleHelp: () => void;
  closeHelp: () => void;
  setSelected: (value: number) => void;
  setDraft: (anchor: CommentAnchor | null) => void;
  setDraftText: (text: string) => void;
  onReviewKey: (e: React.KeyboardEvent) => void;
}

/** 拉取变更清单（进入面板 / sessionTick 变化时刷新）。 */
function useChangesList(api: ApiClient, sessionTick: number) {
  const [data, setData] = React.useState<ChangesData | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [loaded, setLoaded] = React.useState<boolean>(false);

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

  // 挂载拉取清单（[] 有意：只在进入该页时拉一次；sessionTick 变化时重取）。
  React.useEffect(() => {
    void refresh();
  }, [sessionTick]);

  const files = data?.files ?? [];
  return { data, error, loaded, files, isGit: data?.source === 'git', refresh };
}

/** patch 展开状态（含请求代际护栏：迟到响应不得覆盖后点的文件）。 */
function useChangesPatch(
  api: ApiClient,
  clearDraft: () => void,
  refresh: () => Promise<void>,
  refreshComments: () => Promise<void>,
) {
  /** 展开的文件路径（点击查看 patch）。 */
  const [expanded, setExpanded] = React.useState<string | null>(null);
  const [patch, setPatch] = React.useState<string>('');
  const [patchLoading, setPatchLoading] = React.useState<boolean>(false);
  /** patch 加载请求代际：连点两个文件时，先发的慢响应不得覆盖后点的文件。 */
  const patchSeq = React.useRef<number>(0);

  /**
   * 展开 / 收起某文件的 patch。
   * @param path 文件路径
   */
  const openPatch = async (path: string): Promise<void> => {
    if (expanded === path) {
      // 收起也作废在途请求：否则迟到的 patch 会把「已收起」的文件内容重新填进来。
      patchSeq.current++;
      setExpanded(null);
      setPatch('');
      return;
    }
    const seq = ++patchSeq.current;
    setExpanded(path);
    setPatchLoading(true);
    setPatch('');
    clearDraft();
    try {
      const r = await api.listChanges(path);
      if (seq !== patchSeq.current) return;
      setPatch(r.patch ?? '');
    } catch (e) {
      if (seq !== patchSeq.current) return;
      setPatch(t('读取失败：{msg}', { msg: (e as Error).message }));
    } finally {
      if (seq === patchSeq.current) setPatchLoading(false);
    }
  };

  /**
   * 操作后统一刷新：清单 + 当前展开的 patch + 评论。
   * @param path 当前展开的文件路径
   */
  const reloadAfter = async (path: string): Promise<void> => {
    const seq = ++patchSeq.current;
    await refresh();
    await refreshComments();
    try {
      const r = await api.listChanges(path);
      // 期间用户可能已切到别的文件 / 收起：迟到内容不得写进当前视图。
      if (seq !== patchSeq.current) return;
      setPatch(r.patch ?? '');
    } catch {
      /* patch 刷新失败保留旧内容 */
    }
  };

  return { expanded, patch, patchLoading, openPatch, reloadAfter };
}

/** 行内评论：列表 / 草稿 / 增删。 */
function useDiffComments(api: ApiClient, toast: (message: string, kind?: 'err' | 'ok') => void) {
  /** 全部行内评论（工作区级）。 */
  const [comments, setComments] = React.useState<DiffComment[]>([]);
  /** 行内评论草稿锚点。 */
  const [draft, setDraft] = React.useState<CommentAnchor | null>(null);
  const [draftText, setDraftText] = React.useState<string>('');

  /** 拉取行内评论；失败静默（评论不可用不阻断 diff 展示）。 */
  const refreshComments = async (): Promise<void> => {
    try {
      const r = await api.listDiffComments();
      setComments(r.comments ?? []);
    } catch {
      /* 静默 */
    }
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
      toast(t('评论保存失败：{msg}', { msg: (e as Error).message }), 'err');
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
      toast(t('删除失败：{msg}', { msg: (e as Error).message }), 'err');
    }
  };

  return {
    comments,
    draft,
    draftText,
    setDraft,
    setDraftText,
    refreshComments,
    saveDraft,
    deleteComment,
  };
}

/** 审查动作：stage / 丢弃（文件与 hunk 两级），带忙碌键与统一刷新。 */
function useReviewOps(
  api: ApiClient,
  toast: (message: string, kind?: 'err' | 'ok') => void,
  dialog: DialogService,
  reloadAfter: (path: string) => Promise<void>,
) {
  const [busyAct, setBusyAct] = React.useState<string | null>(null);

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

  /** stage 整个文件。 */
  const stageFile = (path: string): void => {
    void runOp('sf:' + path, () => api.stageFile(path), t('已 stage：{path}', { path }), path);
  };

  /** 丢弃整个文件的工作区改动（先经 DialogService 确认）。 */
  const revertFile = async (path: string): Promise<void> => {
    const ok = await dialog.confirm(t('丢弃 {path} 的全部未提交改动？此操作不可恢复。', { path }), {
      title: t('丢弃改动'),
      confirmLabel: t('丢弃'),
      danger: true,
    });
    if (!ok) return;
    await runOp('rf:' + path, () => api.revertFile(path), t('已还原：{path}', { path }), path);
  };

  /** stage 单个 hunk。 */
  const stageHunk = (path: string, hunk: string, isNew: boolean, idx: number): void => {
    void runOp(
      'sh:' + path + ':' + idx,
      () => api.stageHunk(path, hunk, isNew),
      t('已 stage 该块'),
      path,
    );
  };

  /** 丢弃单个 hunk（先经 DialogService 确认）。 */
  const revertHunk = async (path: string, hunk: string, idx: number): Promise<void> => {
    const ok = await dialog.confirm(t('丢弃该改动块？工作区对应行将被还原。'), {
      title: t('丢弃改动块'),
      confirmLabel: t('丢弃'),
      danger: true,
    });
    if (!ok) return;
    await runOp('rh:' + path + ':' + idx, () => api.revertHunk(path, hunk), t('已还原该块'), path);
  };

  return { busyAct, stageFile, revertFile, stageHunk, revertHunk };
}

/** 键盘评审游标 + 快捷键帮助（权威值在 ReviewCursor，state 只触发重渲染）。 */
function useReviewKeyboard(input: {
  files: readonly ChangeFile[];
  expanded: string | null;
  patch: string;
  openFile: ChangeFile | null;
  isGit: boolean;
  openPatch: (path: string) => Promise<void>;
  stageHunk: (path: string, hunk: string, isNew: boolean, idx: number) => void;
  revertHunk: (path: string, hunk: string, idx: number) => Promise<void>;
  setDraft: (anchor: CommentAnchor | null) => void;
  setDraftText: (text: string) => void;
  toast: (message: string, kind?: 'err' | 'ok') => void;
}) {
  const [, setSelected] = React.useState<number>(-1);
  const [help, setHelp] = React.useState<boolean>(false);
  const rootRef = React.useRef<HTMLDivElement | null>(null);
  const cursorRef = React.useRef<ReviewCursor | null>(null);
  if (cursorRef.current === null) cursorRef.current = new ReviewCursor();
  const cursor = cursorRef.current;

  // 进入变更页即把焦点交给评审区：Tab 之后 j/k/a/r 才生效，屏幕阅读器也据此定位。
  React.useEffect(() => {
    rootRef.current?.focus();
  }, []);

  const hunkCount = input.expanded === null ? 0 : DiffHunkSplitter.split(input.patch).length;
  const selectedView = cursor.sync(input.expanded === null ? input.files.length : hunkCount);

  /**
   * 键盘评审：把裸键解析成动作，落到「当前条目清单」（收起时＝文件，展开时＝改动块）上。
   * @param e 键盘事件
   */
  const onReviewKey = (e: React.KeyboardEvent): void => {
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
    const hunks = input.expanded === null ? [] : DiffHunkSplitter.split(input.patch);
    const count = input.expanded === null ? input.files.length : hunks.length;
    if (action === 'next' || action === 'prev' || action === 'first' || action === 'last') {
      e.preventDefault();
      setSelected(cursor.move(action, count));
      return;
    }
    if (count === 0) {
      if (action !== 'open') input.toast(t('先在列表里展开一个文件，再对改动块操作'), 'err');
      return;
    }
    // 序号一律从 cursor 读权威值：state 是渲染镜像，同一帧内连按 j 时它还没更新。
    const idx = ReviewKeyboard.clamp(cursor.at(), count);
    handleReviewAction(e, action, idx, { ...input, hunks, setSelected });
  };

  /** 帮助开合（按钮与键盘共用同一权威状态）。 */
  const toggleHelp = (): void => {
    setHelp(cursor.toggleHelp());
  };

  /** 收起帮助（按钮关闭与 Esc 共用同一出口）。 */
  const closeHelp = (): void => {
    cursor.closeHelp();
    setHelp(false);
  };

  return { rootRef, help, setHelp, toggleHelp, closeHelp, selectedView, setSelected, onReviewKey };
}

/** 非移动类评审动作（打开文件 / 评论 / stage / 丢弃）。 */
function handleReviewAction(
  e: React.KeyboardEvent,
  action: ReturnType<typeof ReviewKeyboard.resolve>,
  idx: number,
  ctx: {
    files: readonly ChangeFile[];
    expanded: string | null;
    patch: string;
    openFile: ChangeFile | null;
    isGit: boolean;
    hunks: ReturnType<typeof DiffHunkSplitter.split>;
    openPatch: (path: string) => Promise<void>;
    stageHunk: (path: string, hunk: string, isNew: boolean, idx: number) => void;
    revertHunk: (path: string, hunk: string, idx: number) => Promise<void>;
    setDraft: (anchor: CommentAnchor | null) => void;
    setDraftText: (text: string) => void;
    toast: (message: string, kind?: 'err' | 'ok') => void;
    setSelected: (value: number) => void;
  },
): void {
  if (action === 'open') {
    if (ctx.expanded === null) {
      const target = ctx.files[idx];
      if (target) void ctx.openPatch(target.path);
    }
    return;
  }
  if (ctx.expanded === null || ctx.openFile === null) {
    ctx.toast(t('先在列表里展开一个文件，再对改动块操作'), 'err');
    return;
  }
  if (!ctx.isGit) {
    ctx.toast(t('非 git 工作区不支持 stage / 丢弃 / 行内评论'), 'err');
    return;
  }
  const hunk = ctx.hunks[idx];
  if (hunk === undefined) return;
  if (action === 'comment') {
    const anchor = firstAnchorOfHunk(ctx.patch, idx, ctx.openFile.path);
    if (anchor === null) {
      ctx.toast(t('该改动块没有可评论的改动行'), 'err');
      return;
    }
    ctx.setDraft(anchor);
    ctx.setDraftText('');
    return;
  }
  e.preventDefault();
  const hunkText = DiffHunkSplitter.text(hunk);
  const isNewFile = !ctx.patch.includes('@@') || ctx.openFile.status === '??';
  if (action === 'accept') ctx.stageHunk(ctx.openFile.path, hunkText, isNewFile, idx);
  else if (action === 'reject') void ctx.revertHunk(ctx.openFile.path, hunkText, idx);
}

/**
 * 变更审查的组合入口。
 * @returns 渲染所需的全部状态与动作。
 */
export function useChangesReview(): ChangesReview {
  const { api, toast, dialog, sessionTick } = useApp();
  const list = useChangesList(api, sessionTick);
  const comments = useDiffComments(api, toast);
  const patch = useChangesPatch(
    api,
    () => comments.setDraft(null),
    list.refresh,
    comments.refreshComments,
  );
  const ops = useReviewOps(api, toast, dialog, patch.reloadAfter);
  const keyboard = useReviewKeyboard({
    files: list.files,
    expanded: patch.expanded,
    patch: patch.patch,
    openFile: list.files.find((f) => f.path === patch.expanded) ?? null,
    isGit: list.isGit,
    openPatch: patch.openPatch,
    stageHunk: ops.stageHunk,
    revertHunk: ops.revertHunk,
    setDraft: comments.setDraft,
    setDraftText: comments.setDraftText,
    toast,
  });
  React.useEffect(() => {
    void comments.refreshComments();
  }, [sessionTick]);
  return {
    ...list,
    ...patch,
    ...comments,
    ...ops,
    ...keyboard,
    openFile: list.files.find((f) => f.path === patch.expanded) ?? null,
  };
}
