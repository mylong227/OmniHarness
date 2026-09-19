// 指标面板：拉取 /metrics + usage.stats 每 2 秒轮询刷新，
// 展示会话/事件/工具调用计数 + Token 消耗统计表（按模型：调用次数 / 输入 / 输出 / 总计）。
//
// 函数组件范式：指标与用量各一个 useState；轮询在 effect 内建立、清理函数里销毁，
// 并用 alive 标志避免卸载后回写（原实现依赖 componentWillUnmount 清定时器）。
// 数字缩写继续复用 NumberFormatter（零 React，可单测）。

import { React } from '../../deps.js';
import { useApp } from '../../context.js';
import { NumberFormatter } from '../../models/NumberFormatter.js';
import type { Metrics } from '../../../types/models.js';

/** 纵向留白。React 的 style 必须是「属性→值」映射，不能传 CSS 字符串。 */
const SPACER: Record<string, string> = { height: '14px' };

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

/**
 * 指标面板：渲染计数卡片、Token 消耗表与事件分布。
 * @returns 指标面板节点
 */
export function MetricsTab(): ReactElement {
  const { api } = useApp();
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
  }, [api]);

  if (!metrics) return <div className="empty">读取中…</div>;

  const et = metrics.eventsByType || {};
  const total = Object.values(et).reduce<number>((a, b) => a + (b as number), 0);
  const cards: [string, string | number][] = [
    ['会话', metrics.sessions || 0],
    ['事件', total],
    ['工具调用', et.tool_call || 0],
    ['Token 总量', usage ? NumberFormatter.abbrev(usage.total.total) : '—'],
  ];
  const models = Object.entries(usage?.byModel ?? {}).sort(([, a], [, b]) => b.total - a.total);

  return (
    <div>
      <div className="metric-grid">
        {cards.map((c) => (
          <div className="metric" key={c[0]}>
            <div className="n">{c[1]}</div>
            <div className="l">{c[0]}</div>
          </div>
        ))}
      </div>
      <div style={SPACER}></div>

      <div className="section-title">Token 消耗统计</div>
      {models.length > 0 ? (
        <>
          <table className="usage-table">
            <thead>
              <tr>
                <th>模型</th>
                <th>调用次数</th>
                <th>输入</th>
                <th>输出</th>
                <th>总计</th>
              </tr>
            </thead>
            <tbody>
              {models.map(([m, s]) => (
                <tr key={m}>
                  <td>{m}</td>
                  <td>{s.calls}</td>
                  <td>{NumberFormatter.abbrev(s.prompt)}</td>
                  <td>{NumberFormatter.abbrev(s.completion)}</td>
                  <td>{NumberFormatter.abbrev(s.total)}</td>
                </tr>
              ))}
              <tr className="total">
                <td>合计</td>
                <td>{usage?.total.calls ?? 0}</td>
                <td>{NumberFormatter.abbrev(usage?.total.prompt ?? 0)}</td>
                <td>{NumberFormatter.abbrev(usage?.total.completion ?? 0)}</td>
                <td>{NumberFormatter.abbrev(usage?.total.total ?? 0)}</td>
              </tr>
            </tbody>
          </table>
          <div className="usage-src">
            数据来源：{usage?.source === 'disk' ? '会话存档（重启不丢）' : '进程内累计（重启清零）'}
          </div>
        </>
      ) : (
        <div className="usage-src">暂无模型调用记录——跑一轮对话后这里会出现统计。</div>
      )}

      <div style={SPACER}></div>
      <div className="section-title">事件分布</div>
      <div id="metricTypes">
        {Object.keys(et)
          .sort()
          .map((k) => (
            <div className="kv" key={k}>
              <span className="k">{k}</span>
              <span className="v">{et[k]}</span>
            </div>
          ))}
      </div>
    </div>
  );
}
