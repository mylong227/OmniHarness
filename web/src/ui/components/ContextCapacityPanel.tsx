// 上下文容量面板（输入区「📊」入口点开）：展示当前会话上下文构成（六类 token 分解 + 窗口占比 +
// 提示缓存命中率）与「今日余额」各模型配额。数据来自 context.usage / context.window / quota.get。
//
// 面向对象：展示逻辑下沉到 ContextUsageView / QuotaView（零 React 依赖，可单测）；
// 组件只负责拉数、渲染与配额档位切换。
//
// 函数组件范式：展开态 / 用量 / 配额 / 加载中各一个 useState；外部点击监听与按需拉数
// 由两个依赖 open 的 effect 承接（原实现需 componentDidUpdate 比对 prevState.open），
// 拉数用 alive 标志避免卸载后回写。

import { React } from '../deps.js';
import { ContextUsageView } from '../models/ContextUsageView.js';
import { QuotaView } from '../models/QuotaView.js';
import type { ContextUsageReport, QuotaStatus } from '../../types/models.js';
import type { ApiClient } from '../../core/ApiClient.js';

/** ContextCapacityPanel 组件的入参。 */
export interface ContextCapacityPanelProps {
  /** 当前会话 id（空串时报告为空）。 */
  threadId: string;
  api: ApiClient;
  /** 配额档位切换提示。 */
  onToast: (msg: string, kind?: 'info' | 'err') => void;
}

/**
 * 上下文容量面板：弹出层展示上下文 token 构成与今日配额，支持切换配额档位。
 * @param props 组件入参
 * @returns 容量面板节点
 */
export function ContextCapacityPanel(props: ContextCapacityPanelProps): ReactElement {
  const { threadId, api, onToast } = props;
  const [open, setOpen] = React.useState<boolean>(false);
  const [usage, setUsage] = React.useState<ContextUsageReport | undefined>(undefined);
  const [quota, setQuota] = React.useState<QuotaStatus | undefined>(undefined);
  const [loading, setLoading] = React.useState<boolean>(false);

  // 展开期间才挂外部点击监听；收起或卸载即摘除（H3 清理对称，deps 只有 open）。
  React.useEffect(() => {
    if (!open) return undefined;
    const close = (): void => setOpen(false);
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, [open]);

  // 展开时拉取容量与配额；卸载或收起即置 alive=false，杜绝迟到回写。
  React.useEffect(() => {
    if (!open) return undefined;
    let alive = true;
    const run = async (): Promise<void> => {
      setLoading(true);
      try {
        const [u, q] = await Promise.all([api.contextUsage(threadId), api.quotaGet()]);
        if (alive) {
          setUsage(u);
          setQuota(q);
          setLoading(false);
        }
      } catch (e) {
        if (alive) {
          setLoading(false);
          onToast('容量数据加载失败：' + (e as Error).message, 'err');
        }
      }
    };
    void run();
    return () => {
      alive = false;
    };
  }, [open, api, threadId, onToast]);

  /** 触发按钮：阻断冒泡后切换展开态。 */
  const toggle = (e: MouseEvent): void => {
    e.stopPropagation();
    setOpen((prev) => !prev);
  };

  /**
   * 切换配额档位（free/plus/pro）。
   * @param plan 档位 id
   * @returns 无
   */
  const onPlan = (plan: string): void => {
    api
      .quotaSet({ plan })
      .then((next: QuotaStatus) => setQuota(next))
      .catch((e: Error) => onToast('配额档位切换失败：' + e.message, 'err'));
  };

  const view = usage !== undefined ? new ContextUsageView(usage) : undefined;
  const quotaView = quota !== undefined ? new QuotaView(quota) : undefined;
  const percent = view !== undefined ? view.barPercent : 0;
  return (
    <div
      className="cap"
      role="button"
      aria-haspopup="dialog"
      aria-expanded={open ? 'true' : 'false'}
      aria-label="上下文容量"
      title="上下文容量与今日余额"
      onClick={toggle}
    >
      <span className="cap-ico">📊</span>
      <span className="cap-bar">
        <span className="cap-bar-fill" style={{ width: percent + '%' }} />
      </span>
      <span className="cap-pct">{view !== undefined ? view.percentText : '—'}</span>
      {open ? (
        <div className="cap-pop" onClick={(e: MouseEvent) => e.stopPropagation()}>
          {loading && !view ? <div className="cap-loading">加载中…</div> : null}
          {view !== undefined ? (
            <div className="cap-section">
              <div className="cap-head">
                <span className="cap-title">上下文容量</span>
                <span className="cap-headline">{view.headline}</span>
                {view.sourceLabel ? <span className="cap-src">{view.sourceLabel}</span> : null}
              </div>
              <div className="cap-bar-big">
                <span className="cap-bar-fill" style={{ width: view.barPercent + '%' }} />
              </div>
              <div className="cap-rows">
                {view.rows.map((row) => (
                  <div className="cap-row" key={row.key} title={row.title}>
                    <span className="cap-row-label">{row.label}</span>
                    <span className="cap-row-bar">
                      <span className="cap-row-fill" style={{ width: row.barPercent + '%' }} />
                    </span>
                    <span className="cap-row-pct">{row.percentText}</span>
                  </div>
                ))}
              </div>
              <div className="cap-foot">
                <span>{view.toolSummary}</span>
                <span title={view.cacheHint}>缓存命中 {view.cacheText}</span>
              </div>
            </div>
          ) : null}
          {quotaView !== undefined ? (
            <div className="cap-section">
              <div className="cap-head">
                <span className="cap-title">今日余额</span>
                {quotaView.badgeText ? <span className="cap-badge">{quotaView.badgeText}</span> : null}
              </div>
              <div className="cap-quota-head">
                <span>剩余 {quotaView.remainingText}</span>
                <span className="cap-reset">{quotaView.resetText} 重置</span>
              </div>
              {quotaView.isEmpty ? (
                <div className="cap-empty">未连接模型，暂无配额数据</div>
              ) : (
                <div className="cap-rows">
                  {quotaView.rows.map((row) => (
                    <div className="cap-row" key={row.name} title={row.title}>
                      <span className="cap-row-label">{row.name}</span>
                      <span className="cap-row-bar">
                        <span
                          className={'cap-row-fill' + (row.exhausted ? ' exhausted' : '')}
                          style={{ width: row.barPercent + '%' }}
                        />
                      </span>
                      <span className="cap-row-pct">{row.percentText}</span>
                    </div>
                  ))}
                </div>
              )}
              <div className="cap-foot">
                <span>{quotaView.budgetHint}</span>
                <span className="cap-dim">{quotaView.sourceLabel}</span>
              </div>
              <div className="cap-plan-row">
                {['free', 'plus', 'pro'].map((plan) => (
                  <button
                    key={plan}
                    className={'cap-plan' + (quota?.plan.id === plan ? ' active' : '')}
                    onClick={() => onPlan(plan)}
                  >
                    {plan === 'free' ? '免费' : plan === 'plus' ? 'Plus' : 'Pro'}
                  </button>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
