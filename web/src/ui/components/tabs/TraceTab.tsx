/**
 * Trace 自省面板（Web 交付项，2026-10-11）：把 `trace.read` 的**冻结条目快照**渲染出来。
 *
 * ## 这一屏回答什么
 *
 * 「这个会话**实际发生过什么**」——条目来自服务端只读投影（`ReadOnlyTraceReader` 深拷贝 +
 * `Object.freeze`，无写方法，agent 无法借道篡改历史）。面板只做两件事：按量/类别取，
 * 然后**原样**列出 `seq / 时刻 / 类别 / 摘要`。
 *
 * ## 三条纪律
 *
 * 1. **会话不存在必须直说**：`result.error` 非空 ⇒ 显示原因（"会话不存在"与"该会话没有事件"
 *    在服务端被刻意区分开，面板不得把它们都渲染成空列表）；
 * 2. **空结果要说明是"查询无匹配"**：`error` 为空且 `count===0` ⇒ 明确写成"本次查询无匹配条目"；
 * 3. **过滤条件照实回显**：类别/条数上限生效时显示出来，避免"只看到 5 条"被读成"总共 5 条"。
 *
 * @returns trace 面板节点
 */
// 标准 React 项目写法：`import * as React from 'react'`（Vite 解析裸标识符）。
import * as React from 'react';
import { useApp } from '../../context.ts';
import { timeOf } from '../../format.ts';
import type { ReactElement } from 'react';
import type { TraceReadResultLike } from '../../../types/models.ts';
import { t } from '../../i18n/i18n.ts';
// 面板级 antd 一律子路径导入（不走 'antd' 桶文件，理由见 vite.config.ts「分块改造」注释）。
import Table from 'antd/es/table';
import type { ColumnsType } from 'antd/es/table';
import Alert from 'antd/es/alert';

/** Trace 面板入参。 */
export interface TraceTabProps {
  /** 目标会话 id（缺省空串 ⇒ 面板提示先选会话，不猜）。 */
  readonly sessionId?: string | null | undefined;
}

/**
 * Trace 过滤区。
 * @param props 过滤值、会话与刷新回调。
 * @returns 过滤区节点。
 */
function TraceFilters(props: {
  kindFilter: string;
  limit: string;
  session: string;
  count: number;
  onKind: (value: string) => void;
  onLimit: (value: string) => void;
  onRefresh: () => void;
}): ReactElement {
  return (
    <div className="detail-section">
      <div className="detail-h">{t('过滤')}</div>
      <label>
        {t('类别')}
        <input
          type="text"
          value={props.kindFilter}
          placeholder={t('如 tool.call（留空＝全部）')}
          onChange={(e: { target: { value: string } }) => props.onKind(e.target.value)}
        />
      </label>
      <label>
        {t('条数上限')}
        <input
          type="text"
          value={props.limit}
          onChange={(e: { target: { value: string } }) => props.onLimit(e.target.value)}
        />
      </label>
      <button type="button" onClick={props.onRefresh}>
        {t('查询')}
      </button>
      <span className="hint">
        {t('会话 {session} · 本次返回 {count} 条', { session: props.session, count: props.count })}
        {props.kindFilter === '' ? '' : t(' · 类别 {kind}', { kind: props.kindFilter })}
      </span>
    </div>
  );
}

/**
 * Trace 条目列表（2026-10-30 W4：antd Table——seq/时刻/类别/摘要四列可扫读）。
 * @param props 条目数组。
 * @returns 列表节点。
 */
function TraceEntries(props: {
  entries: TraceReadResultLike['entries'];
}): ReactElement {
  if (props.entries.length === 0) {
    return <p className="hint">{t('本次查询无匹配条目（会话存在但该条件下没有条目）。')}</p>;
  }
  type Entry = TraceReadResultLike['entries'][number];
  const columns: ColumnsType<Entry> = [
    { title: t('链序号'), dataIndex: 'seq', key: 'seq', width: 80, render: (seq) => `#${String(seq)}` },
    { title: t('时间'), key: 'at', width: 150, render: (_, e) => timeOf(Date.parse(e.at)) },
    { title: t('类别'), dataIndex: 'kind', key: 'kind', width: 140 },
    { title: t('摘要'), key: 'summary', render: (_, e) => e.summary },
  ];
  return (
    <Table<Entry>
      className="trace-table"
      size="small"
      bordered={false}
      pagination={false}
      columns={columns}
      dataSource={[...props.entries]}
      rowKey={(e) => `${String(e.seq)}-${e.kind}`}
      scroll={{ x: 'max-content' }}
    />
  );
}

/**
 * Trace 读取失败提示。
 * @param props 错误文案与重试回调。
 * @returns 提示节点。
 */
function TraceError(props: { message: string; onRetry: () => void }): ReactElement {
  return (
    <div className="trace-tab">
      <Alert type="error" showIcon message={t('读取 trace 失败：{msg}', { msg: props.message })} />
      <button type="button" onClick={props.onRetry}>
        {t('重试')}
      </button>
    </div>
  );
}

/** Trace 自省面板：只读条目列表。 */
export function TraceTab(props: TraceTabProps): ReactElement {
  const { api, sessionTick } = useApp();
  const sessionId = props.sessionId ?? '';
  const [data, setData] = React.useState<TraceReadResultLike | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState<boolean>(true);
  const [kindFilter, setKindFilter] = React.useState<string>('');
  const [limit, setLimit] = React.useState<string>('20');

  /** 拉取只读条目（失败也进状态）。 */
  const refresh = React.useCallback(async (): Promise<void> => {
    if (sessionId === '') {
      setData(null);
      setError(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const parsed = Number.parseInt(limit, 10);
      const r = await api.traceRead({
        session: sessionId,
        ...(kindFilter === '' ? {} : { kind: kindFilter }),
        ...(Number.isFinite(parsed) && parsed > 0 ? { limit: parsed } : {}),
      });
      setData(r);
    } catch (e) {
      setError((e as Error).message);
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [api, sessionId, kindFilter, limit]);

  React.useEffect(() => {
    void refresh();
  }, [refresh, sessionTick]);

  if (sessionId === '') {
    // 不猜会话：空会话时给出明确指引，而不是拿"最近会话"糊一个结果。
    return <div className="trace-tab">{t('请先选择一个会话（trace 自省按会话读取）。')}</div>;
  }
  if (loading) return <div className="trace-tab">{t('载入 trace 条目…')}</div>;
  if (error !== null) {
    return <TraceError message={error} onRetry={() => void refresh()} />;
  }
  if (data === null) return <div className="trace-tab">{t('暂无 trace 数据。')}</div>;
  if (data.error !== undefined) {
    return <TraceError message={data.error} onRetry={() => void refresh()} />;
  }

  return (
    <div className="trace-tab">
      <TraceFilters
        kindFilter={kindFilter}
        limit={limit}
        session={data.session}
        count={data.count}
        onKind={setKindFilter}
        onLimit={setLimit}
        onRefresh={() => void refresh()}
      />
      <TraceEntries entries={data.entries} />
    </div>
  );
}
