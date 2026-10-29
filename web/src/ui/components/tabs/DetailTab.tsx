// 钻取面板：展示从事件流点击选中的事件——类型、摘要与完整结构化 payload。
// 会话消息（user/assistant）额外提供「文档视图」：正文按 markdown 排版呈现，
// 对齐「详情以文件的形式排版布局」的结果展示口径（2026-10-13 用户反馈）。
// 纯展示组件（函数组件范式）：选中事件由 props 注入，无内部状态、无副作用。

import { badge, jsonView, detailSummary, timeOf, emptyState, renderMarkdown } from '../../format.ts';
// 面板级 antd 一律子路径导入（不走 'antd' 桶文件，理由见 vite.config.ts「分块改造」注释）。
import Descriptions from 'antd/es/descriptions';
import Collapse from 'antd/es/collapse';
import { icon } from '../../models/Icon.ts';
import type { ThreadEvent } from '../../../types/models.ts';
import { t } from '../../i18n/i18n.ts';

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
      icon('search', { size: 20 }),
      t('暂无钻取'),
      t('在中间事件流点击任意事件卡片，此处展示其类型、摘要与完整 payload。'),
    );
  }
  const ev = detailEvent;
  const p = ev.payload || {};
  // 会话消息的正文走 markdown 文档视图（文件式排版）；其余事件没有「正文」可排版。
  const content = (ev.type === 'assistant' || ev.type === 'user') && typeof p.content === 'string' ? p.content : '';
  return (
    <div>
      <Descriptions
        className="detail-desc"
        size="small"
        column={1}
        colon={false}
        items={[
          { key: 'type', label: t('类型'), children: badge(ev.type) },
          { key: 'time', label: t('时间'), children: timeOf(ev.timestamp) },
          { key: 'sum', label: t('摘要'), children: detailSummary(ev, p) },
        ]}
      />
      {content === '' ? null : (
        <div className="detail-section">
          <div className="detail-h">{t('全文（文档视图）')}</div>
          <div className="doc-view">{renderMarkdown(content)}</div>
        </div>
      )}
      <div className="detail-section">
        {/* payload 默认展开（与迁移前一致），可折叠让正文视图更聚焦。 */}
        <Collapse
          className="detail-payload"
          size="small"
          defaultActiveKey={['payload']}
          items={[{ key: 'payload', label: t('完整 payload'), children: jsonView(p) }]}
        />
      </div>
    </div>
  );
}
