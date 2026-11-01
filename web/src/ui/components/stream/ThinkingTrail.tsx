// 思考轨迹：一轮里所有「思考 / 说明 / 工具调用」按发生顺序收成**一条**时间线。
//
// 2026-11-01 重做（用户口径）：
//   · 旧版把过程散在对话流里，思考块会随内容长高，把对话顶得很长；一屏还可能出现好几个
//     「执行过程」，读不出先后。现在每轮恒定只有一条轨迹，位置固定在**最终答复之前**：
//     读序为「对话 → 总思考 → 总结结果 → 结果卡」；运行中它是实时思考面板（自带滚动、
//     高度封顶），收尾后自动折叠成一行「总思考」。
//   · 本轮中间的助手消息（「我先看看 / 让我读一下 / 事实核对完毕…」）同样是思考的步骤，
//     标记为「说明」收进同一条轨迹；只有本轮最后一条（最终答复）留在对话里。
//   · 每条思考是一行：左侧状态（运行中 = 旋转环，完成 = ✓）、一句话预览、字数 / 耗时；
//     点击就地展开全文，再点收起。运行中的那条预览跟随末三行，读到的永远是「此刻在想什么」。
//   · 头部给出「思考中 + 当前动作」或「总思考 + 本轮做了什么」，尾部给步数、失败数与耗时。
//
// 数据面只有事件；组件只管状态（展开 / 滚动贴底 / 每秒时钟），不做任何事件改写。

import * as React from 'react';
import { icon } from '../../models/Icon.ts';
import { formatDuration } from '../../models/DurationFormat.ts';
import { describeToolCall, processSummary } from '../../textUtils.ts';
import { t } from '../../i18n/i18n.ts';
import type { ThreadEvent } from '../../../types/models.ts';

/** 思考轨迹组件的入参。 */
export interface ThinkingTrailProps {
  /** 本轮过程事件（reasoning / assistant 旁白 / tool_call / tool_result，含被内联的 tool_result）。 */
  events: readonly ThreadEvent[];
  /** 回合是否进行中（决定实时面板 / 折叠总思考两种形态）。 */
  busy?: boolean;
  /** 回合刚收尾（busy true→false 的 1.5s 内）：播一次「回闪」高亮。 */
  fresh?: boolean;
  /** 本轮首条事件的时间戳（ms；用于第一步思考的耗时口径，0 表示未知）。 */
  startedAt?: number;
  /** 本轮末条事件的时间戳（ms；收尾后与结果卡「耗时」同一口径，0 表示未知）。 */
  endedAt?: number;
  /** 渲染单个非思考事件（工具调用 / 孤儿结果），由 StreamView 注入以避免循环依赖。 */
  renderEvent: (ev: ThreadEvent) => React.ReactElement | null;
}

/** 单条思考行的入参。 */
export interface ReasoningStepProps {
  /** 思考 / 说明事件（payload.content 为全文）。 */
  ev: ThreadEvent;
  /** 是否正在流式生成。 */
  running?: boolean;
  /** 本步耗时（ms；0 / undefined 不显示）。 */
  durationMs?: number;
  /**
   * 行首标签（缺省「思考」）。
   *
   * 过程旁白（本轮中间的 assistant 消息）用「说明」：它同样是思考的一步，
   * 但语义上是「我打算怎么做」，与模型的内部推理区分开。
   */
  label?: string;
}

/** 折叠态预览最多取末几行（运行中读的是「现在」，不是开头）。 */
const PREVIEW_LINES = 3;

/** 取思考正文。 */
function contentOf(ev: ThreadEvent): string {
  const raw: unknown = (ev.payload || {}).content;
  return typeof raw === 'string' ? raw : '';
}

/**
 * 取正文末 N 个非空行（运行中的流式预览）。
 * @param text 正文
 * @param lines 行数
 * @returns 预览文本
 */
function tailLines(text: string, lines: number): string {
  const rows = text.replace(/\r\n/g, '\n').split('\n').filter((row) => row.trim() !== '');
  return rows.slice(-lines).join('\n');
}

/**
 * 取正文第一段（收尾后的静态预览：先读「在想什么」）。
 * @param text 正文
 * @returns 单行预览
 */
function firstLine(text: string): string {
  const row = text.replace(/\r\n/g, '\n').split('\n').find((line) => line.trim() !== '');
  return (row ?? '').trim();
}

/**
 * 事件毫秒时间戳（兼容 number / ISO 字符串；无效为 0）。
 * @param ev 事件
 * @returns 毫秒时间戳
 */
function timeOf(ev: ThreadEvent): number {
  const raw: unknown = ev.timestamp;
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) return raw;
  if (typeof raw === 'string') {
    const parsed = Date.parse(raw);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return 0;
}

/**
 * 本步耗时：事件时间戳减去上一条事件（第一条减去本轮起点）。
 *
 * 口径说明：reasoning 事件是**步末**落盘的，Δt 覆盖的是「上一步结束 → 本步思考完」的
 * 模型往返，正是用户感知的等待时间；拿不到时间戳（旧存档）就不显示，不编造读数。
 * @param events 轨迹事件
 * @param index 当前下标
 * @param startedAt 本轮起点
 * @returns 毫秒；未知时 0
 */
function durationAt(events: readonly ThreadEvent[], index: number, startedAt: number): number {
  const end = timeOf(events[index]!);
  if (end === 0) return 0;
  const prev = index > 0 ? timeOf(events[index - 1]!) : startedAt;
  return prev > 0 && end > prev ? end - prev : 0;
}

/**
 * 步数：思考 / 过程旁白 / 工具调用各算一步（tool_result 只是回执，不重复计数）。
 * @param events 轨迹事件
 * @returns 动作数
 */
function stepCount(events: readonly ThreadEvent[]): number {
  let n = 0;
  for (const ev of events) {
    if (ev.type === 'reasoning' || ev.type === 'assistant' || ev.type === 'tool_call') n += 1;
  }
  return n;
}

/**
 * 失败结果数（`ok !== true` 都算失败，缺字段 fail-closed）。
 * @param events 轨迹事件
 * @returns 失败次数
 */
function failureCount(events: readonly ThreadEvent[]): number {
  let n = 0;
  for (const ev of events) {
    if (ev.type === 'tool_result' && ev.payload?.ok !== true) n += 1;
  }
  return n;
}

/**
 * 运行中的「此刻在做什么」：**最后一条事件**是工具调用时才给动作；
 * 工具已回执 / 正在思考时返回空串（由头部回落成「正在梳理思路」），
 * 避免把上一条调用的动作当成正在发生的事。
 * @param events 轨迹事件
 * @returns 动作描述
 */
function latestAction(events: readonly ThreadEvent[]): string {
  const last = events[events.length - 1];
  if (last === undefined || last.type !== 'tool_call') return '';
  const name = typeof last.payload?.name === 'string' ? last.payload.name : 'tool';
  return describeToolCall(name, last.payload?.args);
}

/**
 * 每秒时钟（只在运行中跳动；收尾即停，避免历史回放空转）。
 * @param running 是否运行中
 * @returns 当前时刻（ms）
 */
function useClock(running: boolean): number {
  const [now, setNow] = React.useState<number>(() => Date.now());
  React.useEffect(() => {
    if (!running) return undefined;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [running]);
  return now;
}

/**
 * 单条思考行：状态 + 预览 + 展开全文。
 * @param props 组件入参
 * @returns 思考行节点
 */
export function ReasoningStep(props: ReasoningStepProps): React.ReactElement {
  const { ev, running, durationMs, label } = props;
  const [open, setOpen] = React.useState<boolean>(false);
  const content = contentOf(ev);
  const preview = running === true ? tailLines(content, PREVIEW_LINES) : firstLine(content);
  const seconds = durationMs !== undefined && durationMs >= 1000 ? Math.round(durationMs / 1000) : 0;
  const meta = [seconds > 0 ? formatDuration(seconds) : '', t('{n} 字', { n: content.length })]
    .filter((part) => part !== '')
    .join(' · ');
  return (
    <div className={'tt-step' + (running === true ? ' running' : '')}>
      <button
        type="button"
        className="tt-step-head"
        aria-expanded={open}
        title={open ? t('收起') : t('点击查看思考内容')}
        onClick={() => setOpen((prev) => !prev)}
      >
        <span className="tt-state" aria-hidden="true">
          {running === true ? <span className="tt-spinner" /> : icon('check', { size: 12 })}
        </span>
        <span className="tt-step-label">{label ?? t('思考')}</span>
        {open ? null : (
          <span className="tt-step-preview">{preview === '' ? t('（无内容）') : preview}</span>
        )}
        <span className="tt-step-meta">{meta}</span>
        <span className={'tt-step-chev' + (open ? ' open' : '')} aria-hidden="true" />
      </button>
      {open ? (
        <div className="tt-think" spellCheck="false">
          {content === '' ? t('（无内容）') : content}
        </div>
      ) : null}
    </div>
  );
}

/**
 * 轨迹头部：运行中 = 思考中 + 当前动作；收尾 = 总思考 + 本轮做了什么。
 * @param props 头部入参
 * @returns 头部按钮节点
 */
function TrailHead(props: {
  running: boolean;
  open: boolean;
  action: string;
  summary: string;
  steps: number;
  failures: number;
  durationMs: number;
  onToggle: () => void;
}): React.ReactElement {
  const { running, open, action, summary, steps, failures, durationMs, onToggle } = props;
  const seconds = durationMs >= 1000 ? Math.round(durationMs / 1000) : 0;
  const meta = [t('{n} 步', { n: steps }), seconds > 0 ? formatDuration(seconds) : '']
    .filter((part) => part !== '')
    .join(' · ');
  return (
    <button
      type="button"
      className={'tt-head' + (running ? ' running' : '')}
      aria-expanded={open}
      title={open ? t('收起思考过程') : t('展开思考过程')}
      onClick={onToggle}
    >
      <span className="tt-icon" aria-hidden="true">
        {running ? <span className="tt-spinner" /> : icon('brain', { size: 14 })}
      </span>
      <span className="tt-title">{running ? t('思考中') : t('总思考')}</span>
      <span className="tt-sub" title={running ? action : summary}>
        {running ? (action === '' ? t('正在梳理思路') : action) : summary}
        {running ? (
          <span className="tt-dots" aria-hidden="true">
            <i></i>
            <i></i>
            <i></i>
          </span>
        ) : null}
      </span>
      {failures > 0 ? <span className="tt-fail">{t('{n} 个失败', { n: failures })}</span> : null}
      <span className="tt-meta">{meta}</span>
      <span className={'tt-chev' + (open ? ' open' : '')} aria-hidden="true" />
    </button>
  );
}

/**
 * 轨迹正文：按顺序渲染思考与工具行（高度封顶、内部滚动）。
 * @param props 事件、运行中的思考 id、本轮起点、渲染回调与滚动句柄
 * @returns 时间线节点
 */
function TrailBody(props: {
  events: readonly ThreadEvent[];
  runningId: string;
  startedAt: number;
  renderEvent: (ev: ThreadEvent) => React.ReactElement | null;
  bodyRef: React.RefObject<HTMLDivElement | null>;
  onScroll: (e: React.UIEvent<HTMLDivElement>) => void;
}): React.ReactElement {
  const { events, runningId, startedAt, renderEvent, bodyRef, onScroll } = props;
  return (
    <div className="tt-body" ref={bodyRef} onScroll={onScroll}>
      {events.map((ev, index) => {
        if (ev.type === 'reasoning' || ev.type === 'assistant') {
          return (
            <ReasoningStep
              key={ev.id}
              ev={ev}
              running={ev.id === runningId}
              durationMs={durationAt(events, index, startedAt)}
              {...(ev.type === 'assistant' ? { label: t('说明') } : {})}
            />
          );
        }
        const node = renderEvent(ev);
        return node === null ? null : (
          <div className="tt-event" key={ev.id}>
            {node}
          </div>
        );
      })}
    </div>
  );
}

/**
 * 思考轨迹：一行总览 + 可展开的有界时间线。
 * @param props 组件入参
 * @returns 轨迹节点；本轮没有任何过程事件时返回 null
 */
export function ThinkingTrail(props: ThinkingTrailProps): React.ReactElement | null {
  const { events, busy, fresh, startedAt, endedAt, renderEvent } = props;
  const running = busy === true;
  const [open, setOpen] = React.useState<boolean>(running);
  const prevRunningRef = React.useRef<boolean>(running);
  const bodyRef = React.useRef<HTMLDivElement | null>(null);
  const stickRef = React.useRef<boolean>(true);
  const now = useClock(running);

  // busy 变化即复位形态：开跑自动展开（看得到实时思考），收尾自动折成一行总思考。
  React.useEffect(() => {
    if (prevRunningRef.current !== running) {
      prevRunningRef.current = running;
      setOpen(running);
      stickRef.current = true;
    }
  }, [running]);

  // 运行中新步骤到达时贴底（用户主动上翻后不再抢滚动位置）。
  // 收尾后首次展开**不**贴底：回看整轮过程应该从第一步读起，而不是直接落到末尾。
  React.useLayoutEffect(() => {
    const el = bodyRef.current;
    if (el !== null && running && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [events, open, running]);

  if (events.length === 0) return null;

  const steps = stepCount(events);
  const failures = failureCount(events);
  const action = latestAction(events);
  const summary = processSummary(events);
  const firstAt = startedAt !== undefined && startedAt > 0 ? startedAt : timeOf(events[0]!);
  // 收尾后优先用「本轮末条事件」（含助手正文 / turn_diff），与结果卡耗时一致；
  // 老数据没有该字段时退回最后一条过程事件。
  const lastAt =
    endedAt !== undefined && endedAt > 0 ? endedAt : timeOf(events[events.length - 1]!);
  const spanMs = running
    ? firstAt > 0
      ? Math.max(0, now - firstAt)
      : 0
    : firstAt > 0 && lastAt > firstAt
      ? lastAt - firstAt
      : 0;
  // 正在写作/调用工具时，最后一条思考已经结束：只有「最后一条过程事件是思考」才算运行中。
  const runningId =
    running && events[events.length - 1]!.type === 'reasoning' ? events[events.length - 1]!.id : '';

  return (
    <section
      className={'ev thinking-trail' + (fresh === true ? ' cluster-fresh' : '')}
      data-running={running ? '1' : undefined}
      aria-label={t('思考轨迹')}
    >
      <TrailHead
        running={running}
        open={open}
        action={action}
        summary={summary}
        steps={steps}
        failures={failures}
        durationMs={spanMs}
        onToggle={() => setOpen((prev) => !prev)}
      />
      {open ? (
        <TrailBody
          events={events}
          runningId={runningId}
          startedAt={firstAt}
          renderEvent={renderEvent}
          bodyRef={bodyRef}
          onScroll={(e: React.UIEvent<HTMLDivElement>) => {
            const el = e.currentTarget;
            stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 32;
          }}
        />
      ) : null}
    </section>
  );
}
