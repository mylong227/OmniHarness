// 回合结果卡：一轮结束后，把「修改的文件」与「新建的文件」统一收在一张卡里。
//
// 2026-11-01 二次改版（用户口径）：
//   · 文件集中：产物只出现在这张卡里，思考步骤内不再内联文件卡；行点击与修改行完全同构
//     （都在右侧面板打开），差异仍可就地展开。
//   · 顺序：修改的文件在前、新建的文件在后（用户明确「新建的在修改文件下方」）。
//   · 头部是一句结果：标题 + 「修改 2 · 新建 1」+ 增删合计 + 耗时；正文先给分组小计，
//     再逐行给路径、增删与入口。卡片默认展开（文件多时收起，避免把结论顶出屏幕）。
//
// 数据面全部来自纯模型 models/TurnSummary（turn_diff ∪ 写类工具成功回执，按路径去重），
// 组件只负责排版与开合状态。

import * as React from 'react';
import { icon } from '../../models/Icon.ts';
import type { IconName } from '../../models/Icon.ts';
import { diffView } from '../../format.ts';
import { buildTurnSummary, type TurnSummaryFile } from '../../models/TurnSummary.ts';
import { formatDurationMs } from '../../models/DurationFormat.ts';
import type { ThreadEvent } from '../../../types/models.ts';
import { t } from '../../i18n/i18n.ts';

/** TurnSummaryCard 组件的入参。 */
export interface TurnSummaryCardProps {
  /** 本轮事件切片（本轮 user 之后到本轮 turn_diff，含 turn_diff）。 */
  events: readonly ThreadEvent[];
  /** 在右侧面板打开文件；返回 false 表示文件已不存在，行会被移除。 */
  onOpenFile?: (path: string) => Promise<boolean> | boolean | void;
}

/** 展示顺序：修改在前、新建在后（用户口径），组内按路径稳定排序。 */
const GROUPS: ReadonlyArray<{ readonly group: 'modified' | 'created'; readonly label: string }> = [
  { group: 'modified', label: '修改的文件' },
  { group: 'created', label: '新建的文件' },
];

/** 卡片默认展开的文件数上限：超过就收起，先让结论留在屏内。 */
const AUTO_OPEN_LIMIT = 10;

/** 图片扩展名（用于给产物行选图标；不引入新的文件类型判定层）。 */
const IMAGE_RE = /\.(?:png|jpe?g|gif|webp|svg|bmp|avif)$/iu;

/**
 * 文件行图标：图片用 image，修改用 pencil，其余用 file。
 * @param f 文件行
 * @returns 图标名
 */
function fileIcon(f: TurnSummaryFile): IconName {
  if (IMAGE_RE.test(f.path)) return 'image';
  return f.group === 'modified' ? 'pencil' : 'file';
}

/**
 * 拆分路径的目录与文件名（目录暗、文件名亮，扫读时先看到文件）。
 * @param path 相对路径
 * @returns `{ dir, name }`
 */
function splitPath(path: string): { dir: string; name: string } {
  const slash = path.lastIndexOf('/');
  return slash < 0
    ? { dir: '', name: path }
    : { dir: path.slice(0, slash + 1), name: path.slice(slash + 1) };
}

/**
 * 文件行右侧动作：差异（仅修改类，就地展开）/ 下载。
 * 「打开」不再单设图标按钮：行主体点击即打开（用户口径「点击在右侧查看」），
 * 少一枚图标，窄屏下路径能多留一截。
 * @param props 文件、差异开合态与回调。
 * @returns 动作区节点。
 */
function FileActions(props: {
  file: TurnSummaryFile;
  hasDiff: boolean;
  diffOpen: boolean;
  onToggleDiff: () => void;
}): ReactElement {
  const { file, hasDiff, diffOpen, onToggleDiff } = props;
  const href = `/files?path=${encodeURIComponent(file.path)}`;
  const stop = (e: React.MouseEvent): void => e.stopPropagation();
  return (
    <span className="ts-actions">
      {hasDiff && file.group === 'modified' ? (
        <button
          type="button"
          className="ts-act"
          onClick={(e: React.MouseEvent) => {
            stop(e);
            onToggleDiff();
          }}
          aria-expanded={diffOpen}
        >
          {diffOpen ? t('收起差异') : t('差异')}
        </button>
      ) : null}
      <a
        className="ts-act ts-act-icon ts-download"
        href={href}
        download={file.name}
        onClick={stop}
        title={t('下载到本地')}
        aria-label={t('下载文件')}
      >
        {icon('download', { size: 13 })}
      </a>
    </span>
  );
}

/**
 * 一行文件：路径 + 增删 / 类型 + 入口。行主体统一「在右侧面板打开」（与修改行一致）。
 * @param props 文件行与开合回调
 * @returns 行节点
 */
function FileRow(props: {
  file: TurnSummaryFile;
  diffOpen: boolean;
  onToggleDiff: () => void;
  onOpenFile?: (path: string) => Promise<boolean> | boolean | void;
}): ReactElement {
  const { file, diffOpen, onToggleDiff, onOpenFile } = props;
  const { dir, name } = splitPath(file.path);
  const hasDiff = file.diff !== '';
  const kindLabel =
    file.kind === 'sketch' || IMAGE_RE.test(file.path)
      ? t('图片')
      : file.kind === 'patch'
        ? t('补丁')
        : t('普通文件');

  return (
    <div className={'ts-file ' + file.group}>
      <div className="ts-row">
        <button
          type="button"
          className="ts-main"
          onClick={() => void onOpenFile?.(file.path)}
          title={t('在右侧面板打开')}
        >
          <span className="ts-ico" aria-hidden="true">{icon(fileIcon(file), { size: 14 })}</span>
          <span className="ts-path" title={file.path}>
            {dir === '' ? null : <span className="ts-dir">{dir}</span>}
            <span className="ts-name">{name}</span>
          </span>
          {hasDiff ? (
            <span className="ts-stat">
              {file.added > 0 ? <span className="add">+{file.added}</span> : null}
              {file.deleted > 0 ? <span className="del">−{file.deleted}</span> : null}
            </span>
          ) : (
            <span className="ts-kind">{kindLabel}</span>
          )}
        </button>
        <FileActions file={file} hasDiff={hasDiff} diffOpen={diffOpen} onToggleDiff={onToggleDiff} />
      </div>
      {hasDiff && file.group === 'modified' && diffOpen ? (
        <div className="ts-diff">{diffView(file.diff)}</div>
      ) : null}
    </div>
  );
}

/**
 * 取本轮 `turn_diff` 的原始文本（最后一个 turn_diff）。
 * @param events 本轮事件
 * @returns diff 文本；没有 turn_diff 时为空串
 */
function rawDiffOf(events: readonly ThreadEvent[]): string {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const ev = events[i]!;
    if (ev.type === 'turn_diff') {
      return typeof ev.payload?.diff === 'string' ? ev.payload.diff : '';
    }
  }
  return '';
}

/**
 * 一组文件的头部：组名 + 文件数 + 组内增删小计。
 * @param props 组名、文件数与小计。
 * @returns 组头节点。
 */
function GroupHead(props: { label: string; count: number; added: number; deleted: number }): ReactElement {
  const { label, count, added, deleted } = props;
  return (
    <div className="ts-group-head">
      <span className="ts-group-name">{t(label)}</span>
      <span className="ts-group-count">{count}</span>
      {added + deleted > 0 ? (
        <span className="ts-group-stat">
          {added > 0 ? <span className="add">+{added}</span> : null}
          {deleted > 0 ? <span className="del">−{deleted}</span> : null}
        </span>
      ) : null}
    </div>
  );
}

/**
 * 结果卡头部：标题、文件计数、增删合计、耗时与开合。
 * @param props 计数、耗时与增删数。
 * @returns 头部节点。
 */
function SummaryHead(props: {
  counts: string;
  duration: string;
  added: number;
  deleted: number;
  open: boolean;
  onToggle: () => void;
}): ReactElement {
  const { counts, duration, added, deleted, open, onToggle } = props;
  return (
    <div className="ts-head">
      <span className="ts-status" aria-hidden="true">{icon('check', { size: 13 })}</span>
      <span className="ts-title">{t('本轮结果')}</span>
      <span className="ts-counts">{counts}</span>
      {added + deleted > 0 ? (
        <span className="ts-total">
          {added > 0 ? <span className="add">+{added}</span> : null}
          {deleted > 0 ? <span className="del">−{deleted}</span> : null}
        </span>
      ) : null}
      {duration === '' ? null : (
        <span className="ts-time" title={t('本轮耗时')}>
          <span className="ts-time-label">{t('耗时')} </span>
          {duration}
        </span>
      )}
      <button
        type="button"
        className="ts-toggle"
        onClick={onToggle}
        aria-expanded={open}
        aria-label={open ? t('收起结果') : t('展开结果')}
        title={open ? t('收起结果') : t('展开结果')}
      >
        <span className={'ts-chev' + (open ? ' open' : '')} aria-hidden="true" />
      </button>
    </div>
  );
}

/**
 * 无法解析文件段时的原始 diff 兜底卡。
 * @param props 原始 diff 与耗时。
 * @returns 兜底卡节点。
 */
function FallbackSummary(props: { rawDiff: string; duration: string }): ReactElement {
  return (
    <div className="turn-summary" role="group" aria-label={t('本轮结果')}>
      <div className="ts-head">
        <span className="ts-status" aria-hidden="true">{icon('check', { size: 13 })}</span>
        <span className="ts-title">{t('本轮结果')}</span>
        {props.duration === '' ? null : (
          <span className="ts-time" title={t('本轮耗时')}>
            <span className="ts-time-label">{t('耗时')} </span>
            {props.duration}
          </span>
        )}
      </div>
      <div className="ts-fallback">{diffView(props.rawDiff)}</div>
    </div>
  );
}

/**
 * 结果卡正文：按「修改 → 新建」分组，每组先给组头小计再列文件。
 * @param props 可见文件、展开的差异集合与回调。
 * @returns 正文节点。
 */
function SummaryBody(props: {
  files: readonly TurnSummaryFile[];
  openDiffs: ReadonlySet<string>;
  onToggleDiff: (path: string) => void;
  onOpenFile: (path: string) => Promise<boolean> | boolean | void;
}): ReactElement {
  const { files, openDiffs, onToggleDiff, onOpenFile } = props;
  return (
    <div className="ts-body">
      {GROUPS.map(({ group, label }) => {
        const groupFiles = files.filter((f) => f.group === group);
        if (groupFiles.length === 0) return null;
        const added = groupFiles.reduce((n, f) => n + f.added, 0);
        const deleted = groupFiles.reduce((n, f) => n + f.deleted, 0);
        return (
          <section className="ts-group" key={group} aria-label={t(label)}>
            <GroupHead label={label} count={groupFiles.length} added={added} deleted={deleted} />
            {groupFiles.map((file) => (
              <FileRow
                key={file.path}
                file={file}
                diffOpen={openDiffs.has(file.path)}
                onToggleDiff={() => onToggleDiff(file.path)}
                onOpenFile={onOpenFile}
              />
            ))}
          </section>
        );
      })}
    </div>
  );
}

/**
 * 统计可见文件的分组计数与增删行数。
 * @param files 可见文件。
 * @returns 计数文案与增删合计。
 */
function countsOf(files: readonly TurnSummaryFile[]): {
  counts: string;
  added: number;
  deleted: number;
} {
  const createdCount = files.filter((f) => f.group === 'created').length;
  const modifiedCount = files.filter((f) => f.group === 'modified').length;
  const counts =
    createdCount > 0 && modifiedCount > 0
      ? t('修改 {m} · 新建 {c}', { m: modifiedCount, c: createdCount })
      : createdCount > 0
        ? t('新建 {c} 个文件', { c: createdCount })
        : t('修改 {m} 个文件', { m: modifiedCount });
  return {
    counts,
    added: files.reduce((n, f) => n + f.added, 0),
    deleted: files.reduce((n, f) => n + f.deleted, 0),
  };
}

/**
 * 回合结果卡。
 * @param props 组件入参
 * @returns 结果卡节点；本轮没有任何文件时返回 null
 */
export function TurnSummaryCard(props: TurnSummaryCardProps): ReactElement | null {
  const { events, onOpenFile } = props;
  const summary = React.useMemo(() => buildTurnSummary(events), [events]);
  const rawDiff = React.useMemo(() => rawDiffOf(events), [events]);
  // 旧 turn_diff 可能仍列着生成后又被删除的临时文件；打开失败（false）时把它从卡里摘掉。
  const [missing, setMissing] = React.useState<ReadonlySet<string>>(() => new Set());
  const visibleFiles = summary.files.filter((f) => !missing.has(f.path));
  const openFile = async (path: string): Promise<boolean> => {
    let ok: boolean | void;
    try {
      ok = await onOpenFile?.(path);
    } catch {
      ok = false;
    }
    if (ok === false) {
      setMissing((prev) => {
        const next = new Set(prev);
        next.add(path);
        return next;
      });
      return false;
    }
    return true;
  };
  // 不足 1s 不显示（避免「耗时 0秒」这种没有信息量的读数）。
  const duration = summary.durationMs >= 1000 ? formatDurationMs(summary.durationMs) : '';
  const [open, setOpen] = React.useState<boolean>(() => summary.files.length <= AUTO_OPEN_LIMIT);
  const [openDiffs, setOpenDiffs] = React.useState<ReadonlySet<string>>(new Set());

  // 解析不出文件段（旧存档 / 非标准 diff）时退回原始 diff，绝不静默吞掉内容。
  if (summary.files.length === 0) {
    if (rawDiff === '') return null;
    return <FallbackSummary rawDiff={rawDiff} duration={duration} />;
  }

  // 全部行都被判定为「已不存在」：整张卡退场，不再展示过期产物。
  if (visibleFiles.length === 0) return null;

  /**
   * 开合某个文件的 diff 正文。
   * @param path 文件路径
   * @returns 无返回值
   */
  const toggleDiff = (path: string): void => {
    setOpenDiffs((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const { counts, added, deleted } = countsOf(visibleFiles);

  return (
    <div className="turn-summary" role="group" aria-label={t('本轮结果')}>
      <SummaryHead
        counts={counts}
        duration={duration}
        added={added}
        deleted={deleted}
        open={open}
        onToggle={() => setOpen((prev) => !prev)}
      />
      {open ? (
        <SummaryBody
          files={visibleFiles}
          openDiffs={openDiffs}
          onToggleDiff={toggleDiff}
          onOpenFile={openFile}
        />
      ) : null}
    </div>
  );
}
