import type { SessionEvent } from '../ports/event.js';
import type { ModelContextSnapshot, ModelUsage } from '../ports/model.js';
import type { ToolDefinition } from '../ports/tool.js';
import { ContextAssembler } from '../context/contextAssembler.js';
import {
  ContextBreakdownEstimator,
  type ContextBreakdown,
  type ContextBreakdownRow,
} from '../context/contextBreakdownEstimator.js';
import { ContextWindowCatalog } from '../context/contextWindowCatalog.js';

/** 提示缓存命中统计（当前会话）。 */
export interface ContextCacheStat {
  /** 参与统计的输入 token 总数（只计**上报了缓存字段**的调用）。 */
  readonly promptTokens: number;
  /** 其中命中缓存的 token 数。 */
  readonly cachedPromptTokens: number;
  /** 上报了缓存字段的模型调用次数。 */
  readonly calls: number;
  /**
   * 平均缓存命中率（0–100，一位小数）。
   * 无任何调用上报缓存字段时为 undefined——UI 显示「—」而不是 0%，
   * 否则「端点没上报」会被读成「缓存完全没命中」。
   */
  readonly hitRate?: number;
}

/** 上下文容量报告（`context.usage` RPC 的返回体，UI 容量面板单一数据源）。 */
export interface ContextUsageReport {
  /** 会话 id（空串表示未选中会话）。 */
  readonly threadId: string;
  /** 上下文窗口 token 数。 */
  readonly windowTokens: number;
  /** 已用 token 数。 */
  readonly usedTokens: number;
  /** 已用占窗口百分比（0–100 一位小数；窗口未知时为 0）。 */
  readonly percent: number;
  /** 六类明细（顺序稳定，含 0 值行）。 */
  readonly rows: readonly ContextBreakdownRow[];
  /** MCP 工具条数。 */
  readonly mcpToolCount: number;
  /** 系统工具条数。 */
  readonly systemToolCount: number;
  /**
   * 数据来源：
   *  - `measured`：最近一次模型调用的实测快照（与真正送出的请求同源，最可信）；
   *  - `estimated`：由事件日志重新投影估算（老会话没有快照，或尚无模型调用）；
   *  - `empty`：会话不存在或没有任何事件。
   */
  readonly source: 'measured' | 'estimated' | 'empty';
  /** 提示缓存命中统计。 */
  readonly cache: ContextCacheStat;
  /** 报告生成时间（ISO 8601）。 */
  readonly collectedAt: string;
}

/** 上下文容量服务依赖。 */
export interface ContextUsageDeps {
  /** 会话事件回放（拿事件日志经 `Agent.replay`）。 */
  readonly replay: (threadId: string) => Promise<readonly SessionEvent[]>;
  /** 本轮可见工具（`ToolPort.listDirect ?? list`）。 */
  readonly tools: () => readonly ToolDefinition[];
  /** 基础常驻系统片段（`config.fragments`）。 */
  readonly baseFragments: () => readonly string[];
  /** 当前生效模型名（查窗口表用）。 */
  readonly model: () => string;
}

/**
 * 上下文容量服务：把「当前会话已用上下文怎么构成的」算清楚，供 UI 容量面板展示。
 *
 * 两条取数路径，**优先实测**：
 *  1. 实测——`StepRunner` 在发请求的同一位置把 `{messages, tools}` 分解成快照写进 `model` 事件
 *     （见 `ports/model.ts` 的 `ModelContextSnapshot`），本服务取**最近一条带快照的事件**直接重建。
 *     优点：与真实请求逐字节同源，含压缩后的历史、动态 repo-map/项目指令等全部真实片段。
 *  2. 估算——老会话（快照上线前）或尚无模型调用时，用 `ContextAssembler` 按当前配置重投影一次。
 *     边界：repo-map 与项目指令这两类**动态片段不在事件日志里**，估算路径会低估「其他」，
 *     因此报告用 `source` 明确标注来源，UI 对估算值加「估算」标记，不与实测值混为一谈。
 *
 * 纯读：不写事件、不改工作区、任何异常都降级为 `empty` 报告（面板宁可空白，不可抛错打断会话）。
 */
export class ContextUsageService {
  /** 六类上下文明细分解器（实测与估算共用）。 */
  private readonly breakdown = new ContextBreakdownEstimator();
  /** 模型上下文窗口表（按模型名查窗口 token 数）。 */
  private readonly windows = new ContextWindowCatalog();

  /**
   * @param deps 回放 / 工具 / 常驻片段 / 当前模型四个取值器
   */
  public constructor(private readonly deps: ContextUsageDeps) {}

  /**
   * 计算某会话的上下文容量报告。
   * @param threadId 会话 id（空串直接返回空报告，不触发回放）
   * @returns 容量报告（含来源标注与缓存命中统计）
   */
  public async usage(threadId: string): Promise<ContextUsageReport> {
    const windowTokens = this.windows.of(this.deps.model());
    if (threadId === '') {
      return this.emptyReport('', windowTokens);
    }
    let events: readonly SessionEvent[];
    try {
      events = await this.deps.replay(threadId);
    } catch {
      // 会话不存在 / 存档不可读：返回空报告，UI 显示「尚无数据」，绝不让面板报错阻断会话。
      return this.emptyReport(threadId, windowTokens);
    }
    const cache = this.cacheStat(events);
    const snapshot = this.latestSnapshot(events);
    if (snapshot !== undefined) {
      const breakdown = this.breakdown.breakdownOf(snapshot);
      return this.reportOf(threadId, breakdown, 'measured', cache);
    }
    if (events.length === 0) {
      return this.emptyReport(threadId, windowTokens, cache);
    }
    const breakdown = this.estimate(events, windowTokens);
    return this.reportOf(threadId, breakdown, 'estimated', cache);
  }

  /**
   * 取最近一条携带上下文快照的 model 事件（倒序扫描，首命中即返回）。
   * @param events 会话事件序列。
   * @returns 最近的有效上下文快照；无则 undefined。
   */
  private latestSnapshot(events: readonly SessionEvent[]): ModelContextSnapshot | undefined {
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const event = events[i];
      if (event === undefined || event.type !== 'model') continue;
      const payload = event.payload as { context?: unknown } | undefined;
      const candidate = payload?.context;
      if (this.isSnapshot(candidate)) return candidate;
    }
    return undefined;
  }

  /**
   * 结构校验：只接受六个分类键齐全、数值非负的快照，脏数据一律当不存在。
   * @param raw 待校验的未知值。
   * @returns 结构合法返回 true（类型收窄为 ModelContextSnapshot）。
   */
  private isSnapshot(raw: unknown): raw is ModelContextSnapshot {
    if (raw === null || typeof raw !== 'object') return false;
    const value = raw as Record<string, unknown>;
    if (typeof value['windowTokens'] !== 'number' || typeof value['usedTokens'] !== 'number') {
      return false;
    }
    if (typeof value['mcpToolCount'] !== 'number' || typeof value['systemToolCount'] !== 'number') {
      return false;
    }
    const tokens = value['tokens'];
    if (tokens === null || typeof tokens !== 'object') return false;
    return typeof (tokens as Record<string, unknown>)['messages'] === 'number';
  }

  /**
   * 估算路径：按当前基础片段重投影事件日志，再与当前可见工具一起分解。
   * @param events 会话事件序列。
   * @param windowTokens 当前模型窗口 token 数。
   * @returns 估算出的上下文分解。
   */
  private estimate(events: readonly SessionEvent[], windowTokens: number): ContextBreakdown {
    const fragments = this.deps.baseFragments();
    const messages = new ContextAssembler(fragments).build(events);
    return this.breakdown.estimate({
      messages,
      tools: this.safeTools(),
      baseFragmentCount: fragments.length,
      windowTokens,
    });
  }

  /**
   * 取工具清单：任何异常都退化为空表（容量面板不该因工具注册表抖动而整体失败）。
   * @returns 当前可见工具定义；异常时为空数组。
   */
  private safeTools(): readonly ToolDefinition[] {
    try {
      return this.deps.tools();
    } catch {
      return [];
    }
  }

  /**
   * 汇总当前会话的提示缓存命中率（只统计上报了缓存字段的调用）。
   * @param events 会话事件序列。
   * @returns 缓存命中统计（无上报调用时 calls=0 且 hitRate 缺省）。
   */
  private cacheStat(events: readonly SessionEvent[]): ContextCacheStat {
    let promptTokens = 0;
    let cachedPromptTokens = 0;
    let calls = 0;
    for (const event of events) {
      if (event.type !== 'model') continue;
      const usage = (event.payload as { usage?: ModelUsage } | undefined)?.usage;
      if (usage === undefined || usage.cachedPromptTokens === undefined) continue;
      promptTokens += usage.promptTokens;
      cachedPromptTokens += usage.cachedPromptTokens;
      calls += 1;
    }
    if (calls === 0) {
      return { promptTokens: 0, cachedPromptTokens: 0, calls: 0 };
    }
    return {
      promptTokens,
      cachedPromptTokens,
      calls,
      hitRate: promptTokens > 0 ? Math.round((cachedPromptTokens / promptTokens) * 1000) / 10 : 0,
    };
  }

  /**
   * 组装报告。
   * @param threadId 会话 id。
   * @param breakdown 上下文分解结果。
   * @param source 数据来源标注（measured / estimated / empty）。
   * @param cache 提示缓存命中统计。
   * @returns 完整容量报告（附生成时间戳）。
   */
  private reportOf(
    threadId: string,
    breakdown: ContextBreakdown,
    source: 'measured' | 'estimated' | 'empty',
    cache: ContextCacheStat,
  ): ContextUsageReport {
    return {
      threadId,
      windowTokens: breakdown.windowTokens,
      usedTokens: breakdown.usedTokens,
      percent: breakdown.percent,
      rows: breakdown.rows,
      mcpToolCount: breakdown.mcpToolCount,
      systemToolCount: breakdown.systemToolCount,
      source,
      cache,
      collectedAt: new Date().toISOString(),
    };
  }

  /**
   * 空报告（全零行，保证 UI 渲染路径一致）。
   * @param threadId 会话 id（可为空串）。
   * @param windowTokens 当前模型窗口 token 数。
   * @param cache 已算出的缓存统计（缺省用全零）。
   * @returns source='empty' 的容量报告。
   */
  private emptyReport(
    threadId: string,
    windowTokens: number,
    cache?: ContextCacheStat,
  ): ContextUsageReport {
    return this.reportOf(
      threadId,
      this.breakdown.estimate({
        messages: [],
        tools: [],
        baseFragmentCount: 0,
        windowTokens,
      }),
      'empty',
      cache ?? { promptTokens: 0, cachedPromptTokens: 0, calls: 0 },
    );
  }
}
