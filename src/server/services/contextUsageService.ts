import type { SessionEvent } from '../../ports/runtime/event.js';
import type { ModelContextSnapshot } from '../../ports/model/model.js';
import type { ToolDefinition } from '../../ports/tool/tool.js';
import { ContextAssembler } from '../../context/contextAssembler.js';
import {
  ContextBreakdownEstimator,
  type ContextBreakdown,
  type ContextBreakdownRow,
} from '../../context/contextBreakdownEstimator.js';
import { ContextWindowCatalog } from '../../context/contextWindowCatalog.js';
import { CacheHitRateWatch } from '../../observability/cacheHitRateWatch.js';
import {
  CacheMissAttributionAnalyst,
  type CacheMissAttribution,
  type CacheMissCause,
} from '../../observability/cacheMissAttributionAnalyst.js';

/** 单条**上报了缓存字段**的调用样本（`cacheStat` 内部备料用；不进公共 API 面）。 */
interface CacheCallSample {
  /** 该次调用的输入 token 数（已钳制：`cached ≤ prompt`）。 */
  readonly promptTokens: number;
  /** 该次调用命中缓存的 token 数。 */
  readonly cachedPromptTokens: number;
  /** 事件时间戳（毫秒）；不可解析时为 NaN（间隔据此判"没有信号"）。 */
  readonly atMs: number;
  /** 该条事件快照里的前缀复用率（0–1）；首次请求或旧快照缺省。 */
  readonly prefixReuseRatio?: number;
}

/**
 * **最近一次**上报缓存的调用的未命中分因（会话聚合之外的独立结论）。
 *
 * 口径（刻意与 {@link ContextCacheStat} 的聚合数字分开，免得两者被读成同一件事的两种说法）：
 *  - token 数与信号都取自**同一条** model 事件（该次调用自己的 `usage` + 它自己的前缀复用率），
 *    不是"聚合 token 配最近一次的信号"——那种混算会产出一句看起来精确、实则对不上的理由；
 *  - `cause === 'hit'` 只说明**最近一次**命中了，会话整体命中率仍以上面的聚合值为准。
 */
export interface ContextCacheLastCall {
  /** 分因（与日志、分因器同一枚举）。 */
  readonly cause: CacheMissCause;
  /** 可直接进面板悬停/日志的**一句话理由**（含具体数字）。 */
  readonly reason: string;
  /** 原始证据（`promptTokens` / `cachedPromptTokens` / `prefixReuseRatio` / `gapMs` / `ttlMs`，JSON 安全）。 */
  readonly evidence: Readonly<Record<string, unknown>>;
  /** 该次调用的输入 token 数（分因的分母，与聚合值可能不同）。 */
  readonly promptTokens: number;
  /** 该次调用命中缓存的 token 数。 */
  readonly cachedPromptTokens: number;
}

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
  /**
   * 最近一次上报缓存的调用的分因（2026-10-15）：把面板上的一个数字变成可行动结论。
   * **恒有值**（没有上报调用时是 `not-reported`，不会缺省）——调用方因此不必处理 undefined。
   */
  readonly lastCall: ContextCacheLastCall;
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
  /**
   * 会话事件**纯读**入口（`Agent.eventsOf`）。
   *
   * **不能接 `Agent.replay`**（2026-10-09 修）：那条路会①把整段历史重新广播给所有客户端，
   * 而本服务在回合进行中被每 2s 轮询一次；②读的是 write-behind 落盘（回合头一两秒盘上为空），
   * 于是面板在用户最想看的时候显示 `0/…` 全零。两条都实测过。
   */
  readonly events: (threadId: string) => Promise<readonly SessionEvent[]>;
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
  /** 命中率坍塌观测器（阈值取自 `OMNI_CACHE_HIT_WARN`，默认 50%）。 */
  private readonly cacheWatch = new CacheHitRateWatch();

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
      events = await this.deps.events(threadId);
    } catch {
      // 会话不存在 / 存档不可读：返回空报告，UI 显示「尚无数据」，绝不让面板报错阻断会话。
      return this.emptyReport(threadId, windowTokens);
    }
    const cache = this.cacheStat(events);
    // 命中率坍塌观测（缺口 C）：只发 warn 级结构化日志，**不阻断**任何业务路径。
    // 分因**同源**：把上面算好的 `lastCall` 结论交给观测器，日志与面板因此不会各说各话
    // （2026-10-15 前这里只传聚合数字，而观测器读的是另一个字段名 ⇒ 日志恒报 "端点未上报"，
    // 与"确实上报了但命中率低"这一事实相反；判据见 `contextUsageCache.test.ts`）。
    this.cacheWatch.inspect({
      promptTokens: cache.promptTokens,
      cachedPromptTokens: cache.cachedPromptTokens,
      calls: cache.calls,
      ...(cache.hitRate !== undefined ? { hitRate: cache.hitRate } : {}),
      attribution: { cause: cache.lastCall.cause, reason: cache.lastCall.reason },
    });
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
   *
   * 口径与防御（都有单测）：
   *  - **按 token 加权**：`Σ cached / Σ prompt`，不是「每次调用命中率的算术平均」——
   *    后者会被短请求放大（一次 10 token 的 0% 命中能盖掉一次 10 万 token 的 90% 命中）。
   *  - 缺 `cachedPromptTokens` 的调用**整条排除**（不计入 calls）：`ModelUsage` 里该字段
   *    缺省即「端点没上报」，与「上报了 0」语义不同，混算会让命中率系统性偏低。
   *  - 脏 payload（`usage` 非对象、token 非有限数 / 负数）整条忽略：污染一个 NaN 就能让
   *    整会话命中率变成 NaN，进而把 UI 的 `%` 与下游告警一起毒化。
   *  - `cachedPromptTokens > promptTokens`（端点脏值）在该条内**钳制到 promptTokens**，
   *    使命中率天然 ≤100%，无需在除法处再特判。
   *  - `promptTokens` 合计为 0 时 `hitRate` 记 0（不产生 NaN / Infinity）。
   *
   * 分因口径（2026-10-15，销掉看板 §8.11 登记的那条遗留）：
   *  - token 数与信号取自**同一条** model 事件（该次调用的 `usage` + 它自己的
   *    `context.prefixReuseRatio`）——**不是**"会话聚合 token 配最后一条事件的信号"；
   *    后者在"最后一次调用没上报"时会张冠李戴，产出一句看着精确、实则对不上的理由。
   *  - `gapMs` = 最近两次**上报**调用的时间戳之差；时间戳非法或倒序时**不给信号**
   *    （宁缺勿编——倒序可能来自时钟回拨，编一个数会让分因指向错误的处置）。
   *  - 没有任何上报调用 ⇒ `not-reported`（"没读数"≠"没命中"），并带 `reportedCalls: 0`，
   *    使"还没跑过模型调用"与"跑过了但端点不给字段"在理由里可分辨。
   * @param events 会话事件序列。
   * @returns 缓存命中统计（无上报调用时 calls=0、hitRate 缺省，`lastCall.cause` 恒有值）。
   */
  private cacheStat(events: readonly SessionEvent[]): ContextCacheStat {
    let promptTokens = 0;
    let cachedPromptTokens = 0;
    let calls = 0;
    let last: CacheCallSample | undefined;
    let previous: CacheCallSample | undefined;
    for (const event of events) {
      if (event.type !== 'model') continue;
      const sample = this.cacheSampleOf(event);
      if (sample === undefined) continue;
      promptTokens += sample.promptTokens;
      cachedPromptTokens += sample.cachedPromptTokens;
      calls += 1;
      previous = last;
      const reuse = this.prefixReuseOf(event);
      last = {
        ...sample,
        atMs: Date.parse(event.timestamp),
        ...(reuse !== undefined ? { prefixReuseRatio: reuse } : {}),
      };
    }
    const attribution = this.attributeLastCall(last, previous, calls);
    return {
      promptTokens,
      cachedPromptTokens,
      calls,
      ...(calls > 0
        ? {
            hitRate:
              promptTokens > 0 ? Math.round((cachedPromptTokens / promptTokens) * 1000) / 10 : 0,
          }
        : {}),
      lastCall: {
        cause: attribution.cause,
        reason: attribution.reason,
        evidence: attribution.evidence,
        promptTokens: last?.promptTokens ?? 0,
        cachedPromptTokens: last?.cachedPromptTokens ?? 0,
      },
    };
  }

  /**
   * 对**最近一次**上报调用分因（复用分因器这一唯一实现，本方法只负责备料）。
   * @param last 最近一次上报调用；无则为 undefined。
   * @param previous 上一次上报调用；无则为 undefined。
   * @param calls 上报调用总数。
   * @returns 分因结果（结论 + 理由 + 证据）。
   */
  private attributeLastCall(
    last: CacheCallSample | undefined,
    previous: CacheCallSample | undefined,
    calls: number,
  ): CacheMissAttribution {
    const gapMs = this.gapBetween(previous, last);
    return CacheMissAttributionAnalyst.attribute({
      // 无上报调用时**不传**该字段：分因器据此判 `not-reported`，而不是"上报了 0 命中"。
      ...(last !== undefined ? { cachedPromptTokens: last.cachedPromptTokens } : {}),
      promptTokens: last?.promptTokens ?? 0,
      hasPreviousRequest: calls > 1,
      reportedCalls: calls,
      ...(last?.prefixReuseRatio !== undefined ? { prefixReuseRatio: last.prefixReuseRatio } : {}),
      ...(gapMs !== undefined ? { gapMs } : {}),
    });
  }

  /**
   * 两次上报调用之间的间隔（毫秒）。
   * @param previous 较早的一次；无则 undefined。
   * @param last 较晚的一次；无则 undefined。
   * @returns 非负间隔；任一时间戳缺失/非法/倒序时 undefined（不编数）。
   */
  private gapBetween(
    previous: CacheCallSample | undefined,
    last: CacheCallSample | undefined,
  ): number | undefined {
    if (previous === undefined || last === undefined) return undefined;
    if (!Number.isFinite(previous.atMs) || !Number.isFinite(last.atMs)) return undefined;
    const gap = last.atMs - previous.atMs;
    return gap >= 0 ? gap : undefined;
  }

  /**
   * 读该条 model 事件快照里的前缀复用率。
   *
   * 只认 `[0,1]` 的有限数：越界值说明写入侧或日志被污染，此时**当没有信号**
   * （分因器会说"缺前缀占比"），绝不拿脏值去判"前缀被改写"。
   * @param event 会话事件（调用方已确认 type === 'model'）。
   * @returns 复用率；缺字段 / 非有限数 / 越界时 undefined。
   */
  private prefixReuseOf(event: SessionEvent): number | undefined {
    const context = (event.payload as { context?: unknown } | undefined)?.context;
    if (context === null || typeof context !== 'object') return undefined;
    const raw = (context as Record<string, unknown>)['prefixReuseRatio'];
    if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0 || raw > 1) return undefined;
    return raw;
  }

  /**
   * 从单条 model 事件里取一份**可用**的缓存样本（脏数据一律返回 undefined）。
   * @param event 会话事件（调用方已确认 type === 'model'）。
   * @returns 钳制后的 `{promptTokens, cachedPromptTokens}`；字段缺失 / 非有限数 / 负数时 undefined。
   */
  private cacheSampleOf(event: SessionEvent):
    | {
        promptTokens: number;
        cachedPromptTokens: number;
      }
    | undefined {
    const usage = (event.payload as { usage?: unknown } | undefined)?.usage;
    if (usage === null || typeof usage !== 'object') return undefined;
    const record = usage as Record<string, unknown>;
    const prompt = this.finiteNonNegative(record['promptTokens']);
    const cached = this.finiteNonNegative(record['cachedPromptTokens']);
    // 无上报（cached === undefined）整条排除；无分母（prompt === undefined）无法加权，同样排除。
    if (prompt === undefined || cached === undefined) return undefined;
    return { promptTokens: prompt, cachedPromptTokens: Math.min(cached, prompt) };
  }

  /**
   * 窄化为有限非负数（NaN / Infinity / 负数 / 非 number 一律 undefined）。
   * @param raw 待窄化的任意值。
   * @returns 有限非负数；不满足时 undefined。
   */
  private finiteNonNegative(raw: unknown): number | undefined {
    if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0) return undefined;
    return raw;
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
   * @param cache 已算出的缓存统计（缺省按"本会话没有任何上报调用"现算一份，
   *   使 `lastCall.cause` 恒有值——调用方不必处理"分因不存在"这一态）。
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
      cache ?? this.cacheStat([]),
    );
  }
}
