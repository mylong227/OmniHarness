// 钻取面板：展示从事件流点击选中的事件——类型、摘要与完整结构化 payload。
// 纯展示组件：选中事件由 props 注入。

import { React } from '../../deps.js';
import { AppComponent } from '../../base/AppComponent.js';
import { badge, jsonView, detailSummary, timeOf, esc, emptyState } from '../../format.js';
import type { ThreadEvent } from '../../../types/models.js';

export interface DetailTabProps {
  detailEvent: ThreadEvent | null;
}

/** 钻取面板组件。 */
export class DetailTab extends AppComponent<DetailTabProps> {
  override render(): ReactElement {
    const { detailEvent } = this.props;
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
}
