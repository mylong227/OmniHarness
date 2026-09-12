// 「今日余额」块的展示模型：档位徽标 + 重置时刻 + 各模型配额行。
// 零 React 依赖，node 环境可直接单测。

import type { QuotaStatus } from '../../types/models.js';
import { TokenScaleFormatter } from './TokenScaleFormatter.js';

/** 单个模型的配额行视图。 */
export interface QuotaRowView {
  /** 模型名。 */
  readonly name: string;
  /** 剩余百分比文本（如 `100%`）。 */
  readonly percentText: string;
  /** 进度条宽度百分比（0–100）。 */
  readonly barPercent: number;
  /** 悬停标题：`已用 0 / 150万 token`。 */
  readonly title: string;
  /** 是否已触顶（剩余 0%，UI 用警示色）。 */
  readonly exhausted: boolean;
}

/**
 * 配额视图。
 *
 * 两个刻意的展示决定：
 *  1. **档位徽标只在升级档出现**（`升级 150% 配额`），免费档不显示徽标——
 *     徽标是「你比默认多拿了多少」的提示，免费档显示「免费 100% 配额」纯属噪声。
 *  2. 重置时刻恒显示（`23:59`），因为「今日余额」这个说法本身就会引出
 *     「几点重置、是不是滚动 24 小时」的疑问，把答案直接摆在数字旁边最省解释。
 */
export class QuotaView {
  private readonly formatter = new TokenScaleFormatter();
  private readonly status: QuotaStatus;

  /**
   * @param status 后端 `quota.get` 状态
   */
  public constructor(status: QuotaStatus) {
    this.status = status;
  }

  /** 档位徽标文本；免费档返回空串（不渲染徽标）。 */
  public get badgeText(): string {
    if (!this.status.plan.upgraded) return '';
    const ratio = Math.round(this.status.plan.multiplier * 100);
    return `升级 ${ratio}% 配额`;
  }

  /** 总剩余百分比文本。 */
  public get remainingText(): string {
    return this.formatter.percent(this.status.remainingPercent);
  }

  /** 重置时刻（本地 `HH:MM`，如 `23:59`）。 */
  public get resetText(): string {
    const date = new Date(this.status.resetAt);
    if (Number.isNaN(date.getTime())) return '23:59';
    const pad = (value: number): string => String(value).padStart(2, '0');
    return pad(date.getHours()) + ':' + pad(date.getMinutes());
  }

  /** 基础日预算说明：`基础预算 100万 × 1.5`。 */
  public get budgetHint(): string {
    const base = this.formatter.compact(this.status.dailyTokens);
    if (!this.status.plan.upgraded) return `基础预算 ${base}/日`;
    return `基础预算 ${base}/日 × ${this.status.plan.multiplier}`;
  }

  /** 各模型配额行（无模型时为空数组）。 */
  public get rows(): QuotaRowView[] {
    return this.status.models.map((model) => ({
      name: model.name,
      percentText: this.formatter.percent(model.remainingPercent),
      barPercent: this.formatter.clampPercent(model.remainingPercent),
      title: `已用 ${this.formatter.compact(model.used)} / ${this.formatter.compact(model.limit)} token`,
      exhausted: model.remainingPercent <= 0,
    }));
  }

  /** 是否无模型可显示（未连厂商 / 未探测到模型）。 */
  public get isEmpty(): boolean {
    return this.status.models.length === 0;
  }

  /**
   * 来源说明文案。
   * 必须出现且措辞明确：这些数字来自**本地日内预算**，不是厂商账户余额——
   * OmniHarness 不代持厂商账单，用户若误以为是账户余额会做出错误的成本判断。
   */
  public get sourceLabel(): string {
    return '按本地日内 token 预算计算（非厂商账户余额）';
  }
}
