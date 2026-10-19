// 回合结果卡：一轮结束后，把「生成的文件」与「修改的文件」统一收在一张卡里。
//
// 为什么要有这张卡（2026-10-19 用户反馈）：
//   · 旧版把每个写类工具的产物卡散在过程流里，回合末尾又有一张 turn_diff 清单，
//     同一个文件会在两处重复出现，读完不知道「这一轮到底产出了什么」；
//   · 现在过程只讲「做了什么」，结果只讲「留下了什么」：生成 / 修改分组、增删合计、
//     打开 / 下载 / 查看差异都在同一行内完成。
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
  /** 本轮事件切片（上一轮 turn_diff 之后到本轮 turn_diff，含 turn_diff）。 */
  events: readonly ThreadEvent[];
  /** 在右侧面板打开文件。 */
  onOpenFile?: (path: string) => void;
}

/** 生成 / 修改两组的展示顺序与标题。 */
const GROUPS: ReadonlyArray<{ readonly group: 'created' | 'modified'; readonly label: string }> = [
  { group: 'created', label: '生成的文件' },
  { group: 'modified', label: '修改的文件' },
];

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
 * 一行文件的打开 / 下载 / 差异入口。
 * @param props 文件行与开合回调
 * @returns 行节点
 */
function FileRow(props: {
  file: TurnSummaryFile;
  diffOpen: boolean;
  onToggleDiff: () => void;
  onOpenFile?: (path: string) => void;
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
  const href = `/files?path=${encodeURIComponent(file.path)}`;

  /**
   * 阻止行级开合冒泡（按钮 / 链接自己处理点击）。
   * @param e 点击事件
   */
  const stop = (e: React.MouseEvent): void => e.stopPropagation();

  /**
   * 行主体：修改类展开差异；生成类直接在右侧打开。
   * @returns 无返回值
   */
  const onMain = (): void => {
    if (hasDiff && file.group === 'modified') onToggleDiff();
    else onOpenFile?.(file.path);
  };

  return (
    <div className={'ts-file ' + file.group}>
      <div className="ts-row">
        <button
          type="button"
          className="ts-main"
          onClick={onMain}
          aria-expanded={hasDiff && file.group === 'modified' ? diffOpen : undefined}
          title={
            hasDiff && file.group === 'modified'
              ? diffOpen
                ? t('收起差异')
                : t('查看差异')
              : t('在右侧面板打开')
          }
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
          <button
            type="button"
            className="ts-act ts-act-icon ts-open"
            onClick={(e: React.MouseEvent) => {
              stop(e);
              onOpenFile?.(file.path);
            }}
            title={t('在右侧面板打开')}
            aria-label={t('在右侧面板打开')}
          >
            {icon('eye', { size: 13 })}
          </button>
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
 * 回合结果卡。
 * @param props 组件入参
 * @returns 结果卡节点；本轮没有任何文件时返回 null
 */
export function TurnSummaryCard(props: TurnSummaryCardProps): ReactElement | null {
  const { events, onOpenFile } = props;
  const summary = React.useMemo(() => buildTurnSummary(events), [events]);
  const rawDiff = React.useMemo(() => rawDiffOf(events), [events]);
  // 不足 1s 不显示（避免「耗时 0秒」这种没有信息量的读数）。
  const duration = summary.durationMs >= 1000 ? formatDurationMs(summary.durationMs) : '';
  // 文件多时先收起（头部仍给出数量与增删合计），避免一次改动几十个文件把结论顶出屏幕。
  const [open, setOpen] = React.useState<boolean>(() => summary.files.length <= 8);
  const [openDiffs, setOpenDiffs] = React.useState<ReadonlySet<string>>(new Set());

  // 解析不出文件段（旧存档 / 非标准 diff）时退回原始 diff，绝不静默吞掉内容。
  if (summary.files.length === 0) {
    if (rawDiff === '') return null;
    return (
      <div className="turn-summary" role="group" aria-label={t('本轮结果')}>
        <div className="ts-head">
          <span className="ts-head-icon" aria-hidden="true">{icon('package', { size: 15 })}</span>
          <span className="ts-title">{t('本轮结果')}</span>
          {duration === '' ? null : (
            <span className="ts-time" title={t('本轮耗时')}>
              <span className="ts-time-label">{t('耗时')} </span>
              {duration}
            </span>
          )}
        </div>
        <div className="ts-fallback">{diffView(rawDiff)}</div>
      </div>
    );
  }

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

  const counts =
    summary.createdCount > 0 && summary.modifiedCount > 0
      ? t('生成 {c} · 修改 {m}', { c: summary.createdCount, m: summary.modifiedCount })
      : summary.createdCount > 0
        ? t('生成 {c} 个文件', { c: summary.createdCount })
        : t('修改 {m} 个文件', { m: summary.modifiedCount });

  return (
    <div className="turn-summary" role="group" aria-label={t('本轮结果')}>
      <div className="ts-head">
        <span className="ts-head-icon" aria-hidden="true">{icon('package', { size: 15 })}</span>
        <span className="ts-title">{t('本轮结果')}</span>
        <span className="ts-counts">{counts}</span>
        {duration === '' ? null : (
          <span className="ts-time" title={t('本轮耗时')}>
            <span className="ts-time-label">{t('耗时')} </span>
            {duration}
          </span>
        )}
        {summary.added + summary.deleted > 0 ? (
          <span className="ts-total">
            {summary.added > 0 ? <span className="add">+{summary.added}</span> : null}
            {summary.deleted > 0 ? <span className="del">−{summary.deleted}</span> : null}
          </span>
        ) : null}
        <button
          type="button"
          className="ts-toggle"
          onClick={() => setOpen((prev) => !prev)}
          aria-expanded={open}
          title={open ? t('收起结果') : t('展开结果')}
        >
          {open ? '▴' : '▾'}
        </button>
      </div>
      {open ? (
        <div className="ts-body">
          {GROUPS.map(({ group, label }) => {
            const files = summary.files.filter((f) => f.group === group);
            if (files.length === 0) return null;
            return (
              <section className="ts-group" key={group} aria-label={t(label)}>
                <div className="ts-group-head">
                  <span className="ts-group-name">{t(label)}</span>
                  <span className="ts-group-count">{files.length}</span>
                </div>
                {files.map((file) => (
                  <FileRow
                    key={file.path}
                    file={file}
                    diffOpen={openDiffs.has(file.path)}
                    onToggleDiff={() => toggleDiff(file.path)}
                    onOpenFile={onOpenFile}
                  />
                ))}
              </section>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
