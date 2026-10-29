// 左栏底部的「上下文容量」小图表 + 向上展开的详情浮层（2026-10-28 用户指定位置）。
//
// 2026-10-28 用户两轮反馈收敛出的形态：
//   · 「显示小的柱状图显示，进度，点击可以向上展开，再点就收起来看音频柱状动效」；
//   · 「重新设计简洁灵动美观，现在有点呆」——所以收起态只留三件东西：
//     一排会呼吸的音频柱、总占比、底部一条极细的进度线；标签与箭头都降到微标签体量。
//   · 展开态不再堆六行进度条：上下文用**一条分段构成条 + 双列图例**（颜色与音频柱一一对应），
//     配额才保留"名称/百分比在上、全宽条在下"的两行排。
//
// 数据由 `useCapacityReport(open)` 取：收起态只随会话事件刷新，展开时才开 5s 兜底轮询。

import * as React from 'react';
import { ContextUsageView } from '../models/ContextUsageView.ts';
import { QuotaView } from '../models/QuotaView.ts';
import { emptyNote } from '../format.ts';
import { t } from '../i18n/i18n.ts';
import { useCapacityReport } from './useCapacityReport.ts';
import { usePopoverEffect } from './usePopoverEffect.ts';
import type { QuotaStatus } from '../../types/models.ts';

/** 弹层在互斥控制器里的身份。 */
const POPOVER_ID = 'capacity';

/** 无数据时的占位柱高（%），只为让收起态保持"音频柱"的形状。 */
const PLACEHOLDER_BARS = [34, 62, 48, 76, 40, 56] as const;

/** 收起态小图表：柱高取分类占「已用上下文」的比例，最低 14% 保证看得见。 */
interface MiniBarsProps {
  /** 六类视图（无数据时 undefined）。 */
  readonly view: ContextUsageView | undefined;
}

/**
 * 收起态的音频柱（纯装饰，语义由按钮 aria-label 承担）。
 * @param props 视图
 * @returns 柱阵节点
 */
function MiniBars(props: MiniBarsProps): ReactElement {
  const rows = props.view?.rows ?? [];
  const shares = rows.length > 0 ? rows.map((row) => row.barPercent) : PLACEHOLDER_BARS;
  // 归一化到"最高的一类 = 100%"：分类占比普遍很小（1.5% 只占 1px），直接用原始百分比
  // 会退化成一条点线；归一化后仍保持相对高低，最低 18% 保证每根都看得见。
  const peak = Math.max(1, ...shares);
  return (
    <span className="cap-dock-chart" aria-hidden="true">
      {shares.map((share, index) => (
        <span
          className="cap-eq-bar"
          key={index}
          style={{
            height: Math.max(18, Math.round((share / peak) * 100)) + '%',
            animationDelay: index * 120 + 'ms',
          }}
        />
      ))}
    </span>
  );
}

/**
 * 分段构成条：六段颜色与图例/音频柱同序（同色相不同明度，不引入新色族）。
 * @param props 视图
 * @returns 分段条节点
 */
function ContextStack(props: { readonly view: ContextUsageView }): ReactElement {
  return (
    <div className="cap-stack" aria-hidden="true">
      {props.view.rows.map((row) => (
        <span key={row.key} style={{ width: row.barPercent + '%' }} />
      ))}
    </div>
  );
}

/** 上下文构成段。 */
interface DockContextSectionProps {
  /** 视图。 */
  readonly view: ContextUsageView;
}

/**
 * 详情浮层里的「上下文构成」段：大号比例 + 分段条 + 双列图例 + 一行脚注。
 * @param props 视图
 * @returns 段落节点
 */
function DockContextSection(props: DockContextSectionProps): ReactElement {
  const { view } = props;
  return (
    <section className="cap-dock-sec">
      <div className="cap-dock-sec-head">
        <span className="cap-dock-sec-title">{t('上下文构成')}</span>
        {view.sourceLabel === '' ? null : <span className="cap-src">{view.sourceLabel}</span>}
      </div>
      <div className="cap-hero">
        <span className="cap-hero-num">{view.headline}</span>
        <span className="cap-hero-accent">{view.percentText}</span>
      </div>
      {view.isEmpty ? (
        emptyNote(t('本会话还没有上下文消耗'), { kind: 'note' })
      ) : (
        <>
          <ContextStack view={view} />
          <div className="cap-legend">
            {view.rows.map((row, index) => (
              <div className="cap-legend-item" key={row.key} title={row.title}>
                <span className={'cap-dot cap-dot-' + String(index + 1)} aria-hidden="true" />
                <span className="cap-legend-label">{row.label}</span>
                <span className="cap-legend-pct">{row.percentText}</span>
              </div>
            ))}
          </div>
        </>
      )}
      <div className="cap-meta">
        <span>{view.toolSummary}</span>
        <span title={view.cacheDetail}>
          {t('缓存命中 {text}', { text: view.cacheText })}
          {view.cacheCauseLabel !== '' ? ' · ' + view.cacheCauseLabel : ''}
        </span>
      </div>
    </section>
  );
}

/** 今日余额段。 */
interface DockQuotaSectionProps {
  /** 配额状态（已过形状守卫）。 */
  readonly status: QuotaStatus;
  /** 配额视图。 */
  readonly view: QuotaView;
}

/**
 * 详情浮层里的「今日余额」段：大号剩余 + 重置时刻 + 模型行 + 档位说明。
 * @param props 状态与视图
 * @returns 段落节点
 */
function DockQuotaSection(props: DockQuotaSectionProps): ReactElement {
  const { status, view } = props;
  return (
    <section className="cap-dock-sec">
      <div className="cap-dock-sec-head">
        <span className="cap-dock-sec-title">{t('今日余额')}</span>
        {view.badgeText === '' ? null : <span className="cap-badge">{view.badgeText}</span>}
      </div>
      <div className="cap-hero">
        <span className="cap-hero-num">{view.remainingText}</span>
        <span className="cap-hero-sub">
          {view.resetText} {t('重置')}
        </span>
      </div>
      {view.isEmpty ? (
        <div className="cap-empty">{view.emptyHint}</div>
      ) : (
        <div className="cap-rows">
          {view.rows.map((row) => (
            <div className="cap-row" key={row.name} title={row.title}>
              <span className="cap-row-label">{row.name}</span>
              <span className="cap-row-pct">{row.percentText}</span>
              <span className="cap-row-bar" aria-hidden="true">
                <span
                  className={'cap-row-fill' + (row.exhausted ? ' exhausted' : '')}
                  style={{ width: row.barPercent + '%' }}
                />
              </span>
            </div>
          ))}
        </div>
      )}
      <div className="cap-plan-note">
        <span className="cap-plan-name">
          {t('档位 {name}', { name: status.plan.label })}
          {status.plan.multiplier !== 1 ? ` × ${status.plan.multiplier}` : ''}
        </span>
        <span className="cap-plan-why">
          {status.planModel !== undefined && status.planModel !== ''
            ? t('按模型 {model} 自动识别', { model: status.planModel })
            : t('未识别到模型，按缺省档')}
        </span>
      </div>
      <div className="cap-meta">
        {/* 来源声明放 title：窄浮层里它会把两行撑成四行；完整文案在设置/权限页常驻。 */}
        <span title={view.sourceLabel}>{view.budgetHint}</span>
      </div>
    </section>
  );
}

/** 浮层主体。 */
interface DockBodyProps {
  /** 容量报告状态与重试。 */
  readonly state: ReturnType<typeof useCapacityReport>;
}

/**
 * 详情浮层主体：错误提示 + 两段（缺数据时给行内说明）。
 * @param props 报告状态
 * @returns 浮层节点
 */
function DockBody(props: DockBodyProps): ReactElement {
  const { usage, quota, loading, error, reload } = props.state;
  const view = ContextUsageView.isReport(usage) ? new ContextUsageView(usage) : undefined;
  // 形状守卫：旧服务端没有 quota.get 时 RPC 回落成 `{}`，直接 new QuotaView 会抛错。
  const quotaStatus =
    quota !== undefined && 'plan' in quota && Array.isArray(quota.models) && quota.plan !== null
      ? quota
      : undefined;
  const quotaView = quotaStatus !== undefined ? new QuotaView(quotaStatus) : undefined;
  return (
    <div
      className="cap-dock-pop"
      role="dialog"
      aria-label={t('上下文容量')}
      onClick={(e: React.MouseEvent) => e.stopPropagation()}
    >
      {error === null ? null : (
        <div className="cap-error" role="status">
          <span>{t('刷新失败：{msg}', { msg: error })}</span>
          <button className="ghost" type="button" onClick={reload}>
            {t('重试')}
          </button>
        </div>
      )}
      {view !== undefined ? (
        <DockContextSection view={view} />
      ) : (
        <div className="cap-dock-sec">
          {loading
            ? emptyNote(t('读取中…'), { kind: 'note' })
            : emptyNote(t('容量数据暂不可用'), { kind: 'note' })}
        </div>
      )}
      {quotaView !== undefined && quotaStatus !== undefined ? (
        <DockQuotaSection status={quotaStatus} view={quotaView} />
      ) : null}
    </div>
  );
}

/**
 * 左栏底部的容量小图表：收起是一排音频柱，展开是向上的详情浮层。
 * @returns 小图表节点
 */
export function CapacityDock(): ReactElement {
  const [open, setOpen] = React.useState<boolean>(false);
  const state = useCapacityReport(open);
  const view = ContextUsageView.isReport(state.usage) ? new ContextUsageView(state.usage) : undefined;
  usePopoverEffect(open, () => setOpen(false), POPOVER_ID);

  return (
    <div
      className="cap-dock-wrap"
      onKeyDown={(e: React.KeyboardEvent) => {
        if (e.key === 'Escape') setOpen(false);
      }}
    >
      {open ? <DockBody state={state} /> : null}
      <button
        className="cap-dock"
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open ? 'true' : 'false'}
        aria-label={
          view !== undefined
            ? t('上下文 {pct}，点击查看详情', { pct: view.percentLabel })
            : t('上下文，点击查看详情')
        }
        title={t('上下文容量')}
        onClick={(e: React.MouseEvent) => {
          e.stopPropagation();
          setOpen((prev) => !prev);
        }}
        onKeyDown={(e: React.KeyboardEvent) => {
          if (e.key === 'Escape') setOpen(false);
        }}
      >
        <span className="cap-dock-row">
          <span className="cap-dock-label">{t('上下文')}</span>
          <MiniBars view={view} />
          <span className="cap-dock-pct">{view !== undefined ? view.percentLabel : '—'}</span>
          <span className="cap-dock-chev" aria-hidden="true">
            ▴
          </span>
        </span>
        <span className="cap-dock-track" aria-hidden="true">
          <span
            className="cap-dock-track-fill"
            style={{ width: (view !== undefined ? view.barPercent : 0) + '%' }}
          />
        </span>
      </button>
    </div>
  );
}
