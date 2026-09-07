// 钻取面板：展示从事件流点击选中的事件——类型、摘要与完整结构化 payload。

import { html } from '../../deps.js';
import { badge, jsonView, detailSummary, timeOf, esc, emptyState } from '../../format.js';
import type { ThreadEvent } from '../../../types/models.js';

export interface DetailTabProps {
  detailEvent: ThreadEvent | null;
}

export function DetailTab(props: DetailTabProps): ReactElement {
  const { detailEvent } = props;
  if (!detailEvent) {
    return emptyState('⤢', '暂无钻取', '在中间事件流点击任意事件卡片，此处展示其类型、摘要与完整 payload。');
  }
  const ev = detailEvent;
  const p = ev.payload || {};
  return html`<div>
    <div className="detail-head">
      ${badge(ev.type)}<span className="time">${timeOf(ev.timestamp)}</span>
    </div>
    <div className="detail-sum">${esc(detailSummary(ev, p))}</div>
    <div className="detail-section">
      <div className="detail-h">完整 payload</div>
      ${jsonView(p)}
    </div>
  </div>`;
}
