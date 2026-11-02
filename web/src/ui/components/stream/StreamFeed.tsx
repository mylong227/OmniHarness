// 事件流主体（2026-11-02 从 StreamView 下沉）：`.stream` 滚动容器 + 虚拟窗口内的块列表。
//
// 为什么单独成文件：这一层只做「滚动容器接线 + 可视块铺排」，不含任何派生计算；
// 抽出去之后 StreamView 只剩数据编排（S2 长函数清偿：原 `StreamView` 体 437 行）。
//
// DOM 契约（组件测试与真机基线断言，勿改）：
//   · 根节点：class="stream"（轨迹视图另加 view-hidden）、对话视图 role=log + aria-live=polite
//     + aria-relevant=additions + aria-label='对话事件流'、data-virtual / data-rendered-count /
//     data-total-count / data-event-count；
//   · 内部固定二选一：`StreamEmpty`（空态）或 `.stream-inner`（载入更早 · 上下占位 ·
//     `.sw-block` 块 · 流式占位行 · 生成中的助手卡片）。
//
// 虚拟化的单位是**可视块**（过程事件已合并成簇），末尾的流式行恒在窗口之外单独渲染。

import * as React from 'react';
import { t } from '../../i18n/i18n.ts';
import { StreamEmpty } from './StreamEmpty.tsx';
import { StreamingAssistantCard } from './StreamingAssistantCard.tsx';
import { StreamLiveRow } from './StreamLiveRow.tsx';
import type { ChatViewKind } from '../ChatHeader.tsx';
import type { DisplayBlock } from '../../textUtils.ts';
import type { StreamWindowMetrics } from '../../models/StreamWindow.ts';
import type { StreamViewProps } from '../StreamView.tsx';

/** 事件流主体入参（StreamView 组装，两个组件共用同一份形状）。 */
export interface StreamFeedProps {
  /** StreamView 的原始入参：空态示例、载入更早、事件计数都从这里取。 */
  readonly stream: StreamViewProps;
  /** 中栏视图（'trace' 时本容器隐藏但保持挂载，避免卸载重挂闪白）。 */
  readonly view: ChatViewKind;
  /** 本帧虚拟窗口指标。 */
  readonly win: StreamWindowMetrics;
  /** 全部可视块（与 `win.start/end` 同维度下标）。 */
  readonly blocks: readonly DisplayBlock[];
  /** 本回合已累积的流式正文（空串表示没有生成中的卡片）。 */
  readonly streaming: string;
  /** 窗口外单独渲染的尾巴行数（流式输入 + 生成中卡片），计入 data-rendered-count。 */
  readonly tailCount: number;
  /** 滚动事件处理器（虚拟化的唯一驱动源）。 */
  readonly onScroll: (e: React.SyntheticEvent) => void;
  /** 滚动容器 ref（贴底 / 测量都读它）。 */
  readonly streamRef: React.RefObject<HTMLDivElement | null>;
  /** 已渲染块的 DOM 登记表（key → 元素），供测量 effect 实测高度。 */
  readonly blockElsRef: React.RefObject<Map<string, HTMLElement>>;
  /** 单块渲染函数（分派器留在 StreamView，这里只调用）。 */
  readonly renderBlock: (b: DisplayBlock) => React.ReactElement | null;
}

/**
 * 取一个可视块的稳定 key：过程簇 / 结果卡用块 key，单块用事件 id。
 * 该 key 同时作为「逐块真实高度索引」的维度（见 BlockHeightIndex）。
 * @param b 可视块
 * @returns 块 key
 */
function blockKeyOf(b: DisplayBlock): string {
  return b.kind === 'single' ? b.event.id : b.key;
}

/**
 * 虚拟化占位块：高度为 0 时不渲染（与下沉前 `> 0 ? <div/> : null` 同义）。
 * @param props 组件入参
 * @returns 占位节点或 null
 */
function StreamPad(props: { readonly side: 'top' | 'bottom'; readonly height: number }): React.ReactElement | null {
  if (props.height <= 0) return null;
  return (
    <div
      key={'stream-pad-' + props.side}
      className="stream-pad"
      style={{ height: props.height + 'px' }}
      aria-hidden="true"
    />
  );
}

/**
 * 事件流滚动容器：`.stream` + 播报属性 + 可断言信号（virtual / rendered / total / event 计数）。
 * @param props 组件入参
 * @returns 滚动容器节点
 */
export function StreamFeed(props: StreamFeedProps): React.ReactElement {
  const { events, liveInputs, onUseStarter } = props.stream;
  const empty = events.length === 0 && liveInputs.length === 0 && props.streaming === '';
  return (
    <div
      className={'stream' + (props.view === 'trace' ? ' view-hidden' : '')}
      role={props.view === 'trace' ? undefined : 'log'}
      aria-live="polite"
      aria-relevant="additions"
      aria-label={t('对话事件流')}
      aria-hidden={props.view === 'trace' ? 'true' : undefined}
      data-virtual="1"
      data-rendered-count={String(props.win.rendered + props.tailCount)}
      data-total-count={String(props.blocks.length + props.tailCount)}
      data-event-count={String(events.length)}
      ref={props.streamRef}
      onScroll={props.onScroll}
    >
      {empty ? <StreamEmpty onUseStarter={onUseStarter} /> : <StreamInner {...props} />}
    </div>
  );
}

/**
 * `.stream-inner`：载入更早按钮 + 上下占位 + 可视块 + 流式占位行 + 生成中助手卡片。
 * @param props 组件入参（与 StreamFeed 同一份）
 * @returns 内层节点
 */
export function StreamInner(props: StreamFeedProps): React.ReactElement {
  const { liveInputs, onLoadEarlier, historyHasMore, historyLoading } = props.stream;
  const blockElsRef = props.blockElsRef;
  const visible = props.blocks.slice(props.win.start, props.win.end);
  return (
    <div className="stream-inner">
      {onLoadEarlier !== undefined && historyHasMore === true ? (
        <div className="stream-load-earlier">
          <button type="button" className="ghost" disabled={historyLoading === true} onClick={onLoadEarlier}>
            {historyLoading === true ? t('加载中…') : t('加载更早的消息')}
          </button>
        </div>
      ) : null}
      <StreamPad key="stream-pad-top" side="top" height={props.win.padTop} />
      {visible.map((b) => {
        const k = blockKeyOf(b);
        return (
          <div
            className="sw-block"
            data-sw-key={k}
            key={'sw-' + k}
            ref={(el: HTMLDivElement | null) => {
              if (el) blockElsRef.current.set(k, el);
              else blockElsRef.current.delete(k);
            }}
          >
            {props.renderBlock(b)}
          </div>
        );
      })}
      <StreamPad key="stream-pad-bottom" side="bottom" height={props.win.padBottom} />
      {liveInputs.map((li) => (
        <StreamLiveRow key={li.id} li={li} />
      ))}
      {props.streaming !== '' ? <StreamingAssistantCard key="streaming-assistant" text={props.streaming} /> : null}
    </div>
  );
}
