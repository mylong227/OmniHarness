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
  /**
   * 本条请求相对**上一条请求**的字节级前缀复用率（0–1，来自 `PrefixStability.prefixReuse`）。
   *
   * 为什么落进快照：提示缓存只复用字节级公共前缀，故复用率是"缓存为什么没命中"唯一
   * **可离线测量**的本机信号（TTL 那一半由事件时间戳给出）。此前它只在请求路径里打一条 debug 日志
   * ⇒ 容量面板拿不到信号，只能显示一个 0% 而无从解释（看板 §8.11 登记的那条遗留）。
   *
   * 只存数值证据（与 `tokens` 同口径，不存标签）：缺省 = 首次请求（没有可比基准）或旧快照无此字段，
   * 读取侧必须把"未知"与"复用率 0"分开处理。
   */
  readonly prefixReuseRatio?: number;
}
