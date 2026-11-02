// 中栏状态栏（2026-11-02 从 StreamView 下沉）。
//
// 只显示**真实可得**的口径（适配器摘要 / 会话事件数 / 连接态），不虚构 token 速率。
// 编排续跑芯片也挂在这里：它属于「有东西没跑完」的状态提示，不该要求用户先学会
// 「全部面板 → 编排」这套导航。

import * as React from 'react';
import { t } from '../../i18n/i18n.ts';
import { GraphResumeChip } from '../GraphResumeChip.tsx';
import type { StreamViewProps } from '../StreamView.tsx';

/**
 * 底部状态栏：适配器摘要 · 续跑芯片 · 事件数 · 连接态。
 * @param props StreamView 的入参（整体透传，口径与下沉前相同）
 * @returns 状态栏节点
 */
export function StreamStatusBar(props: StreamViewProps): React.ReactElement {
  return (
    <div className="chat-status">
      <span className="cs-item">{props.adapter === undefined || props.adapter === '' ? '…' : props.adapter}</span>
      <span className="flex-spacer" aria-hidden="true"></span>
      {props.graphRuns === undefined || props.onGraphResume === undefined ? null : (
        <GraphResumeChip runs={props.graphRuns} onResume={props.onGraphResume} />
      )}
      <span className="cs-item">{t('{n} 条事件', { n: String(props.events.length) })}</span>
      {props.streamState === undefined ? null : (
        <span className={'cs-item cs-conn ' + props.streamState}>
          {props.streamState === 'open' ? t('已连接') : props.streamState === 'connecting' ? t('重连中') : t('断开')}
        </span>
      )}
    </div>
  );
}
