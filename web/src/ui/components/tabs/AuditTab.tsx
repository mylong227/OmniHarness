/**
 * 审计面板（Web 交付项，2026-10-11）：把服务端审计事件（哈希链）按过滤条件列出。
 *
 * ## 为什么这一屏重要
 *
 * 审计是"事后可复核"的唯一凭据面。它最容易出的错**不是**渲染难看，而是把**没有数据**当成
 * "没有问题"：服务端未接线 audit sink 时，旧实现回**空数组** ⇒ 面板渲染成"审计无记录"。
 * 故本面板第一纪律：`ok:false` ⇒ 显示**未接线 + 原因**，绝不显示成"无记录"。
 *
 * 其余两条：
 * 2. **链序号可见**：每条显示 `#seq`（哈希链写入后才有值）——它是"这条记录在链上的位置"，
 *    排查篡改时是第一个要看的字段；
 * 3. **过滤条件照实回显**：类型过滤生效时必须让用户看到"当前过滤的是什么"，否则"只有 1 条"
 *    会被误读成"总共就 1 条"。
 *
 * @returns 审计面板节点
 */
// 标准 React 项目写法：`import * as React from 'react'`（Vite 解析裸标识符）。
import * as React from 'react';
import { useApp } from '../../context.js';
import { timeOf } from '../../format.js';
import type { ReactElement } from 'react';
import type { AuditQueryResult } from '../../../types/models.js';
import { t } from '../../i18n/i18n.js';

/** 审计面板：过滤 + 列表。 */
export function AuditTab(): ReactElement {
  const { api } = useApp();
  const [data, setData] = React.useState<AuditQueryResult | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState<boolean>(true);
  const [typeFilter, setTypeFilter] = React.useState<string>('');

  /** 拉取审计事件（失败也进状态：UI 必须能显示"读不出来"）。 */
  const refresh = React.useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const r = await api.auditQuery(typeFilter === '' ? {} : { type: typeFilter });
      setData(r);
    } catch (e) {
      setError((e as Error).message);
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [api, typeFilter]);

  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  if (loading) return <div className="audit-tab">{t('载入审计事件…')}</div>;
  if (error !== null) {
    return (
      <div className="audit-tab">
        <p className="err">{t('读取审计数据失败：{msg}', { msg: error })}</p>
        <button type="button" onClick={() => void refresh()}>
          {t('重试')}
        </button>
      </div>
    );
  }
  return (
    <div className="audit-tab">
      <div className="detail-section">
        <div className="detail-h">{t('过滤')}</div>
        <label>
          {t('类型')}
          <input
            type="text"
            value={typeFilter}
            placeholder={t('如 tool_call（留空＝全部）')}
            onChange={(e: { target: { value: string } }) => setTypeFilter(e.target.value)}
          />
        </label>
        <button type="button" onClick={() => void refresh()}>
          {t('查询')}
        </button>
        {typeFilter !== '' ? <span className="hint">{t('当前过滤类型：{type}', { type: typeFilter })}</span> : null}
      </div>

      {data !== null && !data.ok ? (
        // 纪律①：未接线必须直说——不得退化成"无记录"。
        <p className="err">{t('未接线：{reason}', { reason: data.reason })}</p>
      ) : data !== null && data.ok ? (
        data.events.length === 0 ? (
          <p className="hint">{t('本次查询无匹配事件（审计 sink 已接线）。')}</p>
        ) : (
          <div className="detail-section">
            <div className="detail-h">{t('事件（{count}）', { count: data.events.length })}</div>
            <ul>
              {data.events.map((event, index) => (
                <li key={`${String(index)}-${event.type}-${String(event.seq ?? '')}`}>
                  {event.seq === undefined ? t('（未入链）') : `#${String(event.seq)}`} ·{' '}
                  {event.ts === undefined ? t('（无时间戳）') : timeOf(Date.parse(event.ts))} · {event.type}
                  {event.sessionId === undefined ? '' : ` · ${t('会话 {id}', { id: event.sessionId })}`}
                  {event.actor === undefined ? '' : ` · ${event.actor}`}
                </li>
              ))}
            </ul>
          </div>
        )
      ) : (
        <p className="hint">{t('暂无审计数据。')}</p>
      )}
    </div>
  );
}
