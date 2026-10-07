// 上下文容量面板（输入区的图表入口点开）：展示当前会话上下文构成（六类 token 分解 + 窗口占比 +
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
import { icon } from '../models/Icon.js';
import type { ContextUsageReport, QuotaStatus } from '../../types/models.js';
import type { ApiClient } from '../../core/ApiClient.js';

/**
 * 面板打开且回合进行中时的实时刷新间隔（毫秒）。
 *
 * 取值理由：容量快照随每一步推进（真机单步数秒），2s 足以让数字"活着"；
 * 而 `context.usage` 每次要回放事件日志，再密就是白烧 IO（面板只在忙时轮询，见下面的 effect）。
 */
const LIVE_REFRESH_MS = 2000;

/** ContextCapacityPanel 组件的入参。 */
export interface ContextCapacityPanelProps {
  /** 当前会话 id（空串时报告为空）。 */
  threadId: string;
  api: ApiClient;
  /**
   * 回合是否进行中（**刷新信号 + 实时轮询开关**）。
   *
   * 为什么必须传：`context.usage` 的用量快照是**回合推进中逐步产生**的——面板在回合开始前打开
   * 就会一直显示 `0/…` 全零（实测：开面板后再发消息，数字不变；用户报的「上下文显示不对」即此）。
   * 把 busy 纳入依赖 ⇒ 回合开始/结束各刷新一次；而打开期间**忙时还会按 {@link LIVE_REFRESH_MS}
   * 持续轮询**，让数字在长回合里跟着走（2026-10-07 用户报「不会实时计算显示刷新」）。
   */
  busy?: boolean;
  /** 配额档位切换提示。 */
  onToast: (msg: string, kind?: 'info' | 'err') => void;
}

/**
 * 上下文容量面板：弹出层展示上下文 token 构成与今日配额，支持切换配额档位。
 * @param props 组件入参
 * @returns 容量面板节点
 */
export function ContextCapacityPanel(props: ContextCapacityPanelProps): ReactElement {
  const { threadId, api, onToast, busy } = props;
  const [open, setOpen] = React.useState<boolean>(false);
  const [usage, setUsage] = React.useState<ContextUsageReport | undefined>(undefined);
  const [quota, setQuota] = React.useState<QuotaStatus | undefined>(undefined);
  const [loading, setLoading] = React.useState<boolean>(false);

  // **取数 effect 的依赖只允许语义相关的量**（2026-10-06 实测的"上下文重复刷"）：
  // 老实现把 `api` / `onToast` / `busy` 一起写进依赖数组，而父组件 Composer 传的是
  // **内联箭头** `onToast={(m,k) => onToast?.(m,k)}` ⇒ 父组件每渲染一次就产生一个新身份 ⇒
  // effect 被判定"依赖变了" ⇒ 重新 `context.usage` + `quota.get` 两个 RPC，再 `setUsage/setQuota`
  // （新对象）⇒ 面板重渲染 ⇒ …… 实测**面板打开后 6 秒内打了 23 次 /rpc**，界面一直停在「加载中…」。
  // 回调与 api **不该**是"数据源"：它们只被调用，不参与判断"要不要重新取数"，故放进 ref。
  const apiRef = React.useRef(api);
  apiRef.current = api;
  const toastRef = React.useRef(onToast);
  toastRef.current = onToast;
  /** 本次展开是否已经报过取数失败（防"失败 ⇒ toast ⇒ 父重渲染 ⇒ 再取数"再次成环）。 */
  const reportedRef = React.useRef<boolean>(false);
  /**
   * 刷新计数：由「打开期间的实时轮询」推动，取数 effect 只依赖它 + 三个语义量。
   *
   * 为什么需要（2026-10-07 用户实测：「不会实时计算显示刷新容量面板上的数据」）：容量快照是
   * **回合推进中逐步产生**的，而面板原先只在「展开 / 换会话 / 忙闲翻转」三个时刻各取一次数 ——
   * 回合跑着跑着数字就冻住了（真机现象：回合进行中一直显示 `0/12.8万` 全零）。
   */
  const [tick, setTick] = React.useState<number>(0);

  // 实时刷新：**面板打开 且 回合进行中**时按固定间隔自增 tick。
  // 只在忙时轮询的理由：闲时用量不会再变，而 `context.usage` 要回放整个事件日志 —— 闲着也轮询
  // 等于白烧 CPU/IO（大会话上尤其明显）。回合结束那一下由下面的 deps 里的 `busy` 负责兜住。
  React.useEffect(() => {
    if (!open || busy !== true) return undefined;
    if (typeof window.setInterval !== 'function') return undefined;
    const timer = window.setInterval(() => setTick((t) => t + 1), LIVE_REFRESH_MS);
    return () => {
      window.clearInterval(timer);
    };
  }, [open, busy]);

  // 展开期间才挂外部点击监听；收起或卸载即摘除（H3 清理对称，deps 只有 open）。
  React.useEffect(() => {
    if (!open) return undefined;
    const close = (): void => setOpen(false);
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, [open]);

  // 取数：展开时拉容量与配额；收起 / 切换会话 / 回合忙闲变化 / 实时轮询 tick 变化时重新拉。
  // `busy` 与 `tick` 都是**刷新信号**（用量快照在回合推进中才产生，见上面的实时轮询）。
  // 卸载或收起即置 alive=false，杜绝迟到回写。
  React.useEffect(() => {
    if (!open) return undefined;
    reportedRef.current = false;
    let alive = true;
    const run = async (): Promise<void> => {
      setLoading(true);
      try {
        const [u, q] = await Promise.all([apiRef.current.contextUsage(threadId), apiRef.current.quotaGet()]);
        if (alive) {
          setUsage(u);
          setQuota(q);
          setLoading(false);
        }
      } catch (e) {
        if (alive) {
          setLoading(false);
          // 每次展开只报一次：否则「失败 ⇒ toast ⇒ 父重渲染 ⇒ 再取数」会自己转起来。
          if (!reportedRef.current) {
            reportedRef.current = true;
            toastRef.current('容量数据加载失败：' + (e as Error).message, 'err');
          }
        }
      }
    };
    void run();
    return () => {
      alive = false;
    };
  }, [open, threadId, busy, tick]);

  /** 触发按钮：阻断冒泡后切换展开态。 */
  const toggle = (e: React.MouseEvent): void => {
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
  // 形状守卫：`QuotaView` 会在取值时直接读 `status.plan.upgraded` / `status.models.map`，而服务端
  // 版本不匹配（旧版没有 `quota.get`，RPC 回落成 `{}`）时构造即抛错 —— 后果不是「这块空着」而是
  // **整个工作台被卸载**（2026-09-27 实测 root 清空、输入区消失）。缺字段就降级为「无配额数据」。
  const hasQuotaShape =
    quota !== undefined && 'plan' in quota && Array.isArray(quota.models) && quota.plan !== null;
  const quotaView = hasQuotaShape ? new QuotaView(quota) : undefined;
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
      <span className="cap-ico">{icon('chart', { size: 14 })}</span>
      <span className="cap-bar">
        <span className="cap-bar-fill" style={{ width: percent + '%' }} />
      </span>
      <span className="cap-pct">{view !== undefined ? view.percentText : '—'}</span>
      {open ? (
        <div className="cap-pop" onClick={(e: React.MouseEvent) => e.stopPropagation()}>
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
                <div className="cap-empty">{quotaView.emptyHint}</div>
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
