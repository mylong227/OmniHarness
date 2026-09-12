// 上下文容量面板的展示模型：把后端报告映射成「标题 + 行 + 缓存行」的纯视图数据。
// 零 React 依赖，node 环境可直接单测。

import type { ContextUsageReport, ContextUsageRow } from '../../types/models.js';
import { TokenScaleFormatter } from './TokenScaleFormatter.js';

/** 单行视图数据。 */
export interface ContextUsageRowView {
  /** 分类键（React key 与图标映射用）。 */
  readonly key: string;
  /** 分类名（后端下发，UI 不自造）。 */
  readonly label: string;
  /** 该类 token 数。 */
  readonly tokens: number;
  /** 占已用上下文的百分比文本（如 `64.1%`）。 */
  readonly percentText: string;
  /** 进度条宽度百分比（0–100，已 clamp）。 */
  readonly barPercent: number;
  /** 悬停标题：`消息 · 7.5万 token`。 */
  readonly title: string;
}

/**
 * 上下文容量视图。
 *
 * 一条关键的口径说明：**行内百分比的分母是「已用上下文」，不是窗口**。
 * 面板顶部那根进度条才是「已用 / 窗口」。两者混用会出现
 * 「六行加起来 600%」这种自相矛盾的界面，故本类只暴露已算好的文本与宽度，
 * 组件层不再做任何百分比运算。
 */
export class ContextUsageView {
  private readonly formatter = new TokenScaleFormatter();
  private readonly report: ContextUsageReport;

  /**
   * @param report 后端 `context.usage` 报告
   */
  public constructor(report: ContextUsageReport) {
    this.report = report;
  }

  /** 标题右侧的主数字：`11.7万/100万`。 */
  public get headline(): string {
    return this.formatter.compact(this.report.usedTokens) + '/' + this.formatter.compact(this.report.windowTokens);
  }

  /** 标题右侧的百分比：`11.7%`。 */
  public get percentText(): string {
    return '(' + this.formatter.percent(this.report.percent) + ')';
  }

  /** 顶部进度条宽度百分比。 */
  public get barPercent(): number {
    return this.formatter.clampPercent(this.report.percent);
  }

  /** 六行分类明细（顺序由后端给定，含 0 值行以保证界面不跳动）。 */
  public get rows(): ContextUsageRowView[] {
    return this.report.rows.map((row) => this.rowView(row));
  }

  /** 平均缓存命中率文本（无数据为 `—`）。 */
  public get cacheText(): string {
    return this.formatter.percent(this.report.cache.hitRate);
  }

  /** 缓存统计的补充说明（`基于 12 次调用`）；无数据时为空串。 */
  public get cacheHint(): string {
    return this.report.cache.calls > 0 ? `基于 ${this.report.cache.calls} 次调用` : '端点未上报缓存字段';
  }

  /**
   * 数据来源标签：`实测` / `估算` / 空串。
   * 估算值必须显式标注——它按事件日志重投影，缺动态片段（repo-map / 项目指令），
   * 不标注就会让用户把估算当精确值看。
   */
  public get sourceLabel(): string {
    if (this.report.source === 'measured') return '实测';
    if (this.report.source === 'estimated') return '估算';
    return '';
  }

  /** 是否无数据（无会话或会话为空）。 */
  public get isEmpty(): boolean {
    return this.report.source === 'empty' || this.report.usedTokens === 0;
  }

  /** 工具条数汇总文本：`MCP 4 · 系统 12`。 */
  public get toolSummary(): string {
    return `MCP ${this.report.mcpToolCount} · 系统 ${this.report.systemToolCount}`;
  }

  /** 单行视图。 */
  private rowView(row: ContextUsageRow): ContextUsageRowView {
    return {
      key: row.key,
      label: row.label,
      tokens: row.tokens,
      percentText: this.formatter.percent(row.percent),
      barPercent: this.formatter.clampPercent(row.percent),
      title: `${row.label} · ${this.formatter.compact(row.tokens)} token`,
    };
  }
}
