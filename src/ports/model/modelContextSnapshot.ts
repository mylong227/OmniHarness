import type { ContextCategoryKey } from './contextCategoryKey.js';

/**
 * 一次模型请求的上下文占用快照（随 `model` 事件落日志，供 UI 容量面板读取**实测值**）。
 *
 * 只存 token 数、工具计数与窗口大小：中文标签与百分比是展示层推导结果，
 * 存进日志会在改文案/改口径时留下历史脏数据，故一律由读取侧重建。
 */
export interface ModelContextSnapshot {
  /** 本次请求所用的上下文窗口 token 数。 */
  readonly windowTokens: number;
  /** 已用 token 数。 */
  readonly usedTokens: number;
  /** 本轮可见的 MCP 工具条数。 */
  readonly mcpToolCount: number;
  /** 本轮可见的系统（内置）工具条数。 */
  readonly systemToolCount: number;
  /** 分类 token 数（六个键齐全，无数据为 0）。 */
  readonly tokens: Readonly<Record<ContextCategoryKey, number>>;
}
