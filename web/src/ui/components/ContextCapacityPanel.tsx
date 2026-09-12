// 上下文容量面板（输入区「📊」入口点开）：展示当前会话上下文构成（六类 token 分解 + 窗口占比 +
// 提示缓存命中率）与「今日余额」各模型配额。数据来自 context.usage / context.window / quota.get。
//
// 面向对象：展示逻辑下沉到 ContextUsageView / QuotaView（零 React 依赖，可单测）；
// 组件只负责拉数、渲染与配额档位切换。

import { React } from '../deps.js';
import { ContextUsageView } from '../models/ContextUsageView.js';
import { QuotaView } from '../models/QuotaView.js';
import type { ContextUsageReport, QuotaStatus } from '../../types/models.js';
import type { ApiClient } from '../../core/ApiClient.js';

export interface ContextCapacityPanelProps {
  /** 当前会话 id（空串时报告为空）。 */
  threadId: string;
  api: ApiClient;
  /** 配额档位切换提示。 */
  onToast: (msg: string, kind?: 'info' | 'err') => void;
}

interface ContextCapacityPanelState {
  open: boolean;
  usage?: ContextUsageReport;
  quota?: QuotaStatus;
  loading: boolean;
}

/** 上下文容量面板组件。 */
export class ContextCapacityPanel extends React.Component<ContextCapacityPanelProps, ContextCapacityPanelState> {
  constructor(props: ContextCapacityPanelProps) {
    super(props);
    this.state = { open: false, loading: false };
  }

  override componentDidUpdate(_prev: ContextCapacityPanelProps, prev: ContextCapacityPanelState): void {
    if (prev.open === this.state.open) return;
    if (this.state.open) {
      window.addEventListener('click', this.close);
      void this.load();
    } else {
      window.removeEventListener('click', this.close);
    }
  }

  override componentWillUnmount(): void {
    window.removeEventListener('click', this.close);
  }

  private async load(): Promise<void> {
    const { threadId, api } = this.props;
    this.setState({ loading: true });
    try {
      const [usage, quota] = await Promise.all([api.contextUsage(threadId), api.quotaGet()]);
      this.setState({ usage, quota, loading: false });
    } catch (e) {
      this.setState({ loading: false });
      this.props.onToast('容量数据加载失败：' + (e as Error).message, 'err');
    }
  }

  private readonly close = (): void => {
    this.setState({ open: false });
  };

  private readonly toggle = (e: MouseEvent): void => {
    e.stopPropagation();
    this.setState((prev) => ({ open: !prev.open }));
  };

  private readonly stopBubble = (e: MouseEvent): void => {
    e.stopPropagation();
  };

  /** 切换配额档位（free/plus/pro）。 */
  private readonly onPlan = (plan: string): void => {
    this.props.api
      .quotaSet({ plan })
      .then((next: QuotaStatus) => this.setState({ quota: next }))
      .catch((e: Error) => this.props.onToast('配额档位切换失败：' + e.message, 'err'));
  };

  override render(): ReactElement {
    const { open, usage, quota, loading } = this.state;
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
        onClick={this.toggle}
      >
        <span className="cap-ico">📊</span>
        <span className="cap-bar">
          <span className="cap-bar-fill" style={{ width: percent + '%' }} />
        </span>
        <span className="cap-pct">{view !== undefined ? view.percentText : '—'}</span>
        {open ? (
          <div className="cap-pop" onClick={this.stopBubble}>
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
                      onClick={() => this.onPlan(plan)}
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
}
