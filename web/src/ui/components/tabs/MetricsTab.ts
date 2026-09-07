// 指标面板：拉取 /metrics + usage.stats 每 2 秒轮询刷新，
// 展示会话/事件/工具调用计数 + Token 消耗统计表（按模型：调用次数 / 输入 / 输出 / 总计）。

import { html, React } from '../../deps.js';
import { useApp } from '../../context.js';
import type { Metrics } from '../../../types/models.js';

/** 纵向留白。React 的 style 必须是「属性→值」映射，不能传 CSS 字符串。 */
const SPACER: Record<string, string> = { height: '14px' };

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

/** 千分位缩写：1234 → 1.2k，1234567 → 1.23M。 */
function abbrev(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'k';
  return String(n);
}

export function MetricsTab(): ReactElement {
  const { api } = useApp();
  const [metrics, setMetrics] = React.useState<Metrics | null>(null);
  const [usage, setUsage] = React.useState<UsageStats | null>(null);

  const refresh = React.useCallback(() => {
    api
      .fetchMetrics()
      .then(setMetrics)
      .catch(() => {
        /* 静默：指标端点不可用时保持上一帧 */
      });
    api
      .usageStats()
      .then(setUsage)
      .catch(() => {
        /* 静默：统计 RPC 不可用时保持上一帧 */
      });
  }, [api]);

  React.useEffect(() => {
    refresh();
    const t = setInterval(refresh, 2000);
    return () => clearInterval(t);
  }, [refresh]);

  if (!metrics) return html`<div className="empty">读取中…</div>`;

  const et = metrics.eventsByType || {};
  const total = Object.values(et).reduce<number>((a, b) => a + (b as number), 0);
  const cards = [
    ['会话', metrics.sessions || 0],
    ['事件', total],
    ['工具调用', et.tool_call || 0],
    ['Token 总量', usage ? abbrev(usage.total.total) : '—'],
  ];

  const models = Object.entries(usage?.byModel ?? {}).sort(
    ([, a], [, b]) => b.total - a.total,
  );

  return html`<div>
    <div className="metric-grid">
      ${cards.map(
        (c) =>
          html`<div className="metric" key=${c[0]}><div className="n">${c[1]}</div><div className="l">${c[0]}</div></div>`,
      )}
    </div>
    <div style=${SPACER}></div>

    <div className="section-title">Token 消耗统计</div>
    ${models.length > 0
      ? html`<table className="usage-table">
          <thead>
            <tr>
              <th>模型</th><th>调用次数</th><th>输入</th><th>输出</th><th>总计</th>
            </tr>
          </thead>
          <tbody>
            ${models.map(
              ([m, s]) =>
                html`<tr key=${m}>
                  <td>${m}</td><td>${s.calls}</td>
                  <td>${abbrev(s.prompt)}</td><td>${abbrev(s.completion)}</td><td>${abbrev(s.total)}</td>
                </tr>`,
            )}
            <tr className="total">
              <td>合计</td><td>${usage?.total.calls ?? 0}</td>
              <td>${abbrev(usage?.total.prompt ?? 0)}</td>
              <td>${abbrev(usage?.total.completion ?? 0)}</td>
              <td>${abbrev(usage?.total.total ?? 0)}</td>
            </tr>
          </tbody>
        </table>
        <div className="usage-src">
          数据来源：${usage?.source === 'disk' ? '会话存档（重启不丢）' : '进程内累计（重启清零）'}
        </div>`
      : html`<div className="usage-src">暂无模型调用记录——跑一轮对话后这里会出现统计。</div>`}

    <div style=${SPACER}></div>
    <div className="section-title">事件分布</div>
    <div id="metricTypes">
      ${Object.keys(et)
        .sort()
        .map(
          (k) =>
            html`<div className="kv" key=${k}><span className="k">${k}</span><span className="v">${et[k]}</span></div>`,
        )}
    </div>
  </div>`;
}
