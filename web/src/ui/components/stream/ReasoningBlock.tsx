// 思考过程块：两种形态——
//   1) live（回合进行中，busy=true）：实时「思考中」平铺面板。
//      头部一行「思考中 + 跳动计时（时/分/秒）+ 实时字数」；思考正文以正文色流式长出，**末段**
//      （最后一个换行之后的生长中片段）以更浅斜体呈现——正是本实现「Running …」片段的活跃感；
//      文本末尾带光标。正文整块 aria-hidden，另设粗粒度 polite 状态区（跨百字档才变）。
//      已思时长每秒写入 sessionStorage（按事件 id）：收尾摘要直接读它显示时长，刻意**持续写**
//      而非卸载时写——卸载清理跑在新组件首渲染之后，收尾块的首帧会读到空值（React 提交时序）。
//   2) 收尾（非 live）：折叠成步骤列表的一行「思考 | 内容摘要 | 时长 · 字数」，点击展开全文。
//
// 函数组件范式：仅一个展开态 + 一个计时器，用 useState/useRef/useEffect 承接。

import * as React from 'react';
import { icon } from '../../models/Icon.ts';
import { formatDuration } from '../../models/DurationFormat.ts';
import type { ThreadEvent } from '../../../types/models.ts';
import { t } from '../../i18n/i18n.ts';

/** ReasoningBlock 组件的入参。 */
export interface ReasoningBlockProps {
  /** 思考事件（payload.content 为思考全文）。 */
  ev: ThreadEvent;
  /** 是否正在流式生成（busy=true）。为真时渲染实时「思考中」面板，否则折叠摘要。 */
  live?: boolean;
}

/** 播报粒度：每满这么多字符才更新一次状态文案（其余时刻文本不变 ⇒ 不重播）。 */
const ANNOUNCE_STEP = 100;

/** 已思时长的 sessionStorage 键前缀（会话级；历史会话无记录则不显示时长）。 */
const DUR_KEY = 'omni-reason-dur:';

/**
 * 生成中的播报文案（粗粒度，避免逐字轰炸屏幕阅读器）。
 * @param length 已生成字符数
 * @returns 状态文案
 */
function announceText(length: number): string {
  if (length < ANNOUNCE_STEP) return t('正在思考');
  return t('正在思考（已约 {n} 字）', { n: Math.floor(length / ANNOUNCE_STEP) * ANNOUNCE_STEP });
}

/**
 * 读某条思考事件的已录时长（秒；无记录为 null）。
 * @param eventId 事件 id
 * @returns 秒数或 null
 */
function readDuration(eventId: string): number | null {
  try {
    const raw = window.sessionStorage.getItem(DUR_KEY + eventId);
    if (raw === null) return null;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 1 ? n : null;
  } catch {
    return null;
  }
}

/**
 * 思考过程组件。
 * @param props 组件入参
 * @returns 思考过程节点
 */
export function ReasoningBlock(props: ReasoningBlockProps): ReactElement {
  const { ev, live } = props;
  const [open, setOpen] = React.useState<boolean>(false);
  const [elapsed, setElapsed] = React.useState<number>(0);
  const startedAt = React.useRef<number>(Date.now());
  const p = ev.payload || {};
  const content = (p.content as string) || '';
  // 函数式 updater：不依赖上一次渲染捕获的 open（H5 防陈旧闭包）。
  const toggle = (): void => setOpen((prev) => !prev);

  // live 计时器：每秒跳动并同步落 sessionStorage。卸载即停，无泄漏。
  React.useEffect(() => {
    if (!live) return;
    startedAt.current = Date.now();
    setElapsed(0);
    const tick = (): void => {
      const sec = Math.floor((Date.now() - startedAt.current) / 1000);
      setElapsed(sec);
      try {
        window.sessionStorage.setItem(DUR_KEY + ev.id, String(sec));
      } catch {
        /* 存储不可用时静默：时长属锦上添花，不值得打扰用户 */
      }
    };
    tick();
    const t = window.setInterval(tick, 1000);
    return () => window.clearInterval(t);
  }, [live, ev.id]);

  // —— 流式态：实时「思考中」平铺（无边框，正文色流式文本 + 浅色生长末段） ——
  if (live) {
    // 末段拆分：最后一个换行之后的片段是「正在生长」的部分——更浅斜体（本实现口径）。
    const nl = content.lastIndexOf('\n');
    const settled = nl >= 0 ? content.slice(0, nl) : '';
    const tail = nl >= 0 ? content.slice(nl + 1) : content;
    return (
      <div className="ev reasoning live" spellCheck="false">
        <div className="reason-live-head">
          <span className="reason-spinner" aria-hidden="true">
            {icon('thinking', { size: 15 })}
          </span>
          <span className="reason-live-label">{t('思考中')}</span>
          <span className="reason-dots" aria-hidden="true">
            <i></i>
            <i></i>
            <i></i>
          </span>
          <span className="reason-live-timer">{formatDuration(elapsed)}</span>
          <span className="reason-live-count">{t('{n} 字', { n: content.length })}</span>
        </div>
        <div className="reason-live-body" aria-hidden="true">
          {settled}
          {settled !== '' ? '\n' : ''}
          <span className="reason-live-tail">{tail}</span>
          <span className="reason-caret"></span>
        </div>
        <div className="reason-live-status" role="status" aria-live="polite" aria-atomic="true">
          {announceText(content.length)}
        </div>
      </div>
    );
  }

  // —— 收尾态：折叠摘要（有已录时长则一并显示），点击展开全文 ——
  const durSec = readDuration(ev.id);
  const summary = content.replace(/\s+/g, ' ').trim();
  const meta = durSec !== null ? `${formatDuration(durSec)} · ${content.length} 字` : `${content.length} 字`;
  return (
    <div className="ev reasoning">
      <div
        className="tc-line dim"
        onClick={toggle}
        onKeyDown={(e: React.KeyboardEvent) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            toggle();
          }
        }}
        role="button"
        tabIndex={0}
        aria-expanded={open}
        title={open ? t('收起') : t('点击查看思考内容')}
      >
        <span className="tc-icon">{icon('thinking', { size: 14 })}</span>
        <span className="tc-verb">{t('思考')}</span>
        <span className="tc-dot" aria-hidden="true">
          ·
        </span>
        <span className="tc-subject" title={summary}>
          {summary === '' ? t('（无内容）') : summary}
        </span>
        <span className="tc-meta">{meta}</span>
      </div>
      {open ? (
        <div className="tc-detail">
          <div className="reason-body" spellCheck="false">
            {content}
          </div>
        </div>
      ) : null}
    </div>
  );
}
