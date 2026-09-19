// 钻取面板：展示从事件流点击选中的事件——类型、摘要与完整结构化 payload。
// 纯展示组件（函数组件范式）：选中事件由 props 注入，无内部状态、无副作用。

import { React } from '../../deps.js';
import { badge, jsonView, detailSummary, timeOf, esc, emptyState } from '../../format.js';
import type { ThreadEvent } from '../../../types/models.js';

/** DetailTab 组件的入参。 */
export interface DetailTabProps {
  /** 当前选中的事件；为 null 时展示空状态指引。 */
  detailEvent: ThreadEvent | null;
}

/**
 * 钻取面板：渲染选中事件的类型徽标、摘要与完整 payload。
 * @param props 组件入参
 * @returns 钻取面板节点（无选中事件时为空状态节点）
 */
export function DetailTab(props: DetailTabProps): ReactElement {
  const { detailEvent } = props;
  if (!detailEvent) {
    return emptyState(
      '⤢',
      '暂无钻取',
      '在中间事件流点击任意事件卡片，此处展示其类型、摘要与完整 payload。',
    );
  }
  const ev = detailEvent;
  const p = ev.payload || {};
  return (
    <div>
      <div className="detail-head">
        {badge(ev.type)}
        <span className="time">{timeOf(ev.timestamp)}</span>
      </div>
      <div className="detail-sum">{esc(detailSummary(ev, p))}</div>
      <div className="detail-section">
        <div className="detail-h">完整 payload</div>
        {jsonView(p)}
      </div>
    </div>
  );
}
