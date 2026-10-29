// 指标面板：拉取 /metrics + usage.stats 每 2 秒轮询刷新，
// 展示会话/事件/工具调用计数 + Token 消耗统计表（按模型：调用次数 / 输入 / 输出 / 总计）。
//
// 函数组件范式：指标与用量各一个 useState；轮询在 effect 内建立、清理函数里销毁，
// 并用 alive 标志避免卸载后回写（原实现依赖 componentWillUnmount 清定时器）。
// 数字缩写继续复用 NumberFormatter（零 React，可单测）。
//
// 2026-10-29（W4）：计数卡 → antd `Statistic`，Token 消耗表 / 事件分布 → antd `Table` /
// `Descriptions`（子路径导入，见 vite.config.ts 分块纪律）。数字与口径不变。

import * as React from 'react';
import { emptyNote } from '../../format.ts';
import { useApp } from '../../context.ts';
import { NumberFormatter } from '../../models/NumberFormatter.ts';
import type { Metrics } from '../../../types/models.ts';
import { t } from '../../i18n/i18n.ts';
// 面板级 antd 一律子路径导入（不走 'antd' 桶文件，理由见 vite.config.ts「分块改造」注释）。
import Statistic from 'antd/es/statistic';
import Table from 'antd/es/table';
import type { ColumnsType } from 'antd/es/table';
import Descriptions from 'antd/es/descriptions';

/** 轮询间隔（ms）。 */
const POLL_MS = 2000;

/** 单模型用量行。 */
interface ModelStat {
  calls: number;
  prompt: number;
  completion: number;
  total: number;
}

/** usage.stats RPC 返回结构（与服务端对齐）。 */
interface UsageStats {
  source: 'disk' | 'live';
  dir: string;
  byModel: Record<string, ModelStat>;
  total: ModelStat;
  sessions: { sessionId: string; calls: number; total: number }[];
}

/** Token 消耗表的行（含合计行；合计行用 rowKey='__total__' 固定在末尾）。 */
interface UsageRow {
  readonly key: string;
  readonly model: string;
  readonly calls: number;
  readonly prompt: string;
  readonly completion: string;
  readonly total: string;
  readonly isTotal: boolean;
}

/**
 * Token 消耗表。
 * @param props 按模型的统计与总量。
 * @returns 表格卡片。
 */
function UsageTable(props: {
  models: [string, ModelStat][];
  usage: UsageStats | null;
}): ReactElement {
  const { models, usage } = props;
  if (models.length === 0) {
    return (
      <section className="act-card">
        <div className="section-title">{t('Token 消耗统计')}</div>
        <div className="usage-src">{t('暂无模型调用记录——跑一轮对话后这里会出现统计。')}</div>
      </section>
    );
  }
  const rows: UsageRow[] = [
    ...models.map(([m, s]) => ({
      key: m,
      model: m,
      calls: s.calls,
      prompt: NumberFormatter.abbrev(s.prompt),
      completion: NumberFormatter.abbrev(s.completion),
      total: NumberFormatter.abbrev(s.total),
      isTotal: false,
    })),
    {
      key: '__total__',
      model: t('合计'),
      calls: usage?.total.calls ?? 0,
      prompt: NumberFormatter.abbrev(usage?.total.prompt ?? 0),
      completion: NumberFormatter.abbrev(usage?.total.completion ?? 0),
      total: NumberFormatter.abbrev(usage?.total.total ?? 0),
      isTotal: true,
    },
  ];
  const columns: ColumnsType<UsageRow> = [
    { title: t('模型'), dataIndex: 'model', key: 'model' },
    { title: t('调用次数'), dataIndex: 'calls', key: 'calls', width: 110, align: 'right' },
    { title: t('输入'), dataIndex: 'prompt', key: 'prompt', width: 110, align: 'right' },
    { title: t('输出'), dataIndex: 'completion', key: 'completion', width: 110, align: 'right' },
    { title: t('总计'), dataIndex: 'total', key: 'total', width: 110, align: 'right' },
  ];
  return (
    <section className="act-card">
      <div className="section-title">{t('Token 消耗统计')}</div>
      <Table<UsageRow>
        className="metrics-usage-table"
        size="small"
        bordered={false}
        pagination={false}
        columns={columns}
        dataSource={rows}
        rowKey="key"
        rowClassName={(row) => (row.isTotal ? 'metrics-usage-total' : '')}
        scroll={{ x: 'max-content' }}
      />
      <div className="usage-src">
        {t('数据来源：')}{usage?.source === 'disk' ? t('会话存档（重启不丢）') : t('进程内累计（重启清零）')}
      </div>
    </section>
  );
}

/**
 * 事件类型分布（antd Descriptions：一行一类型，值右对齐由 CSS 负责）。
 * @param props 事件计数表。
 * @returns 分布卡片。
 */
function EventDistribution(props: { counts: Readonly<Record<string, number>> }): ReactElement {
  const keys = Object.keys(props.counts);
  return (
    <section className="act-card">
      <div className="section-title">{t('事件分布')}</div>
      <div id="metricTypes">
        {keys.length === 0 ? (
          <p className="hint">{t('暂无事件记录。')}</p>
        ) : (
          <Descriptions
            className="metrics-event-dist"
            size="small"
            column={1}
            colon={false}
            items={keys
              .sort()
              .map((k) => ({ key: k, label: k, children: String(props.counts[k]) }))}
          />
        )}
      </div>
    </section>
  );
}

/**
 * 指标面板：渲染计数卡片、Token 消耗表与事件分布。
 * @returns 指标面板节点
 */
export function MetricsTab(): ReactElement {
  const { api, sessionId, sessionTick } = useApp();
  const [metrics, setMetrics] = React.useState<Metrics | null>(null);
  const [usage, setUsage] = React.useState<UsageStats | null>(null);

  // 挂载即拉一次并按 POLL_MS 轮询；卸载即停表且不再回写（清理对称）。
  React.useEffect(() => {
    let alive = true;
    /** 拉取指标与用量；任一失败保持上一帧（指标端点不可用不该让面板空白）。 */
    const refresh = async (): Promise<void> => {
      try {
        const m = await api.fetchMetrics();
        if (alive) setMetrics(m);
      } catch {
        /* 静默：指标端点不可用时保持上一帧 */
      }
      try {
        const u = await api.usageStats();
        if (alive) setUsage(u);
      } catch {
        /* 静默：统计 RPC 不可用时保持上一帧 */
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), POLL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [api, sessionTick]);

  if (!metrics) return emptyNote(t('读取中…'), { kind: 'note' });

  const et = metrics.eventsByType || {};
  const total = Object.values(et).reduce<number>((a, b) => a + (b as number), 0);
  // 本会话的两张卡：数据来自 usage.stats 的 per-session 列表，随 sessionTick 实时刷新；
  // 没选会话（新会话态）显示「—」，不拿全量数字冒充本会话。
  const currentSession =
    sessionId === null ? undefined : usage?.sessions.find((s) => s.sessionId === sessionId);
  const cards: [string, string | number][] = [
    [t('本会话 Token'), currentSession ? NumberFormatter.abbrev(currentSession.total) : '—'],
    [t('本会话调用'), currentSession ? currentSession.calls : '—'],
    [t('会话'), metrics.sessions || 0],
    [t('事件'), total],
    [t('工具调用'), et.tool_call || 0],
    [t('Token 总量'), usage ? NumberFormatter.abbrev(usage.total.total) : '—'],
  ];
  const models = Object.entries(usage?.byModel ?? {}).sort(([, a], [, b]) => b.total - a.total);

  return (
    <div className="csl-stack">
      <div className="metric-grid">
        {cards.map((c) => (
          <Statistic
            key={c[0]}
            className="metric"
            title={c[0]}
            value={c[1]}
            valueStyle={{ fontSize: '20px', lineHeight: 1.2 }}
          />
        ))}
      </div>

      <UsageTable models={models} usage={usage} />
      <EventDistribution counts={et as Readonly<Record<string, number>>} />
    </div>
  );
}
