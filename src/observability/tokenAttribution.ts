import type { ModelUsage } from '../ports/model/model.js';
import type { SessionEvent } from '../ports/runtime/event.js';

/**
 * 归因桶键：某次模型调用之前**没有任何工具调用**（首轮 / 纯文本轮 / 收尾轮）时使用。
 */
export const INITIAL_BUCKET = '<initial>';

/** 单桶累计（build 之前的可变形态）。 */
export interface TokenAttributionTally {
  /** 该工具被调用的次数。 */
  toolCalls: number;
  /** 归属于该桶的输入 token 数。 */
  promptTokens: number;
  /** 归属于该桶的输出 token 数。 */
  completionTokens: number;
  /** 归属于该桶的缓存命中输入 token 数。 */
  cachedPromptTokens: number;
}

/** 归因报告条目（按 token 量降序）。 */
export interface TokenAttributionBucket {
  /** 工具名（或 {@link INITIAL_BUCKET}）。 */
  readonly tool: string;
  /** 该工具被调用的次数。 */
  readonly toolCalls: number;
  /** 归属于该桶的输入 token 数。 */
  readonly promptTokens: number;
  /** 归属于该桶的输出 token 数。 */
  readonly completionTokens: number;
  /** 归属于该桶的缓存命中输入 token 数。 */
  readonly cachedPromptTokens: number;
  /** 该桶 token 合计。 */
  readonly totalTokens: number;
  /** 占全会话 token 的比例（0..1；总量为 0 时为 0）。 */
  readonly share: number;
}

/** per-tool token 归因报告（P5）。 */
export interface TokenAttributionReport {
  /** 全会话 token 合计。 */
  readonly totalTokens: number;
  /** 全会话输入 token 合计。 */
  readonly totalPromptTokens: number;
  /** 全会话输出 token 合计。 */
  readonly totalCompletionTokens: number;
  /** 全会话缓存命中输入 token 合计。 */
  readonly totalCachedPromptTokens: number;
  /** 有 usage 的模型调用数（可归因）。 */
  readonly modelCallsWithUsage: number;
  /** 无 usage 的模型调用数（**不可归因**，如实计数而非补零）。 */
  readonly modelCallsWithoutUsage: number;
  /** 各桶（含 {@link INITIAL_BUCKET}），按 token 量降序。 */
  readonly buckets: readonly TokenAttributionBucket[];
}

/**
 * @beta
 * per-tool token 归因（P5）：把会话事件流里的**模型用量**分摊到**工具维度**。
 *
 * **归因规则（明确声明，非因果分解）**：按事件时间序，每次模型调用的 usage 归给
 * 「自上一条 `model` 事件以来出现过的 `tool_call` 工具名集合」——即**该调用摄取了哪些工具的结果**；
 * 若无前驱工具调用（首轮 / 纯文本轮 / 收尾轮）则归入 {@link INITIAL_BUCKET}。
 * 同一批调用涉及多个工具时，usage 在集合内**按桶均分**（保证各桶之和 == 总量，避免双计）。
 *
 * 之所以能纯函数式实现：模型用量（`model` 事件）与工具调用（`tool_call` 事件）都已落**同一条
 * append-only 事件流**，故归因是**对生产事实源的投影**，零热区改动、可离线复算。
 *
 * **诚实边界**：本归因是「结果摄取成本」的近似——真实因果分解不可能（prompt 是累积的），
 * 且同一工具在多轮中被反复调用时无法区分「哪一轮读到了它」。无 usage 的调用如实计入
 * {@link TokenAttributionReport.modelCallsWithoutUsage}，**不补零、不臆造**。
 */
export class TokenAttribution {
  /** 自上次模型调用以来累积的待归因工具名（按出现顺序）。 */
  private readonly pendingTools: string[] = [];
  /** 各桶累计。 */
  private readonly tallies = new Map<string, TokenAttributionTally>();
  /** 有 usage 的模型调用数。 */
  private usageCalls = 0;
  /** 无 usage 的模型调用数。 */
  private missingUsageCalls = 0;

  /**
   * 记录一次工具调用（进入当前待归因批次）。
   *
   * @param name 工具名。
   * @returns 无返回值。
   */
  public recordToolCall(name: string): void {
    this.tallyOf(name).toolCalls += 1;
    this.pendingTools.push(name);
  }

  /**
   * 记录一次模型用量：分摊给当前批次涉及的工具集合，并清空批次。
   *
   * @param usage 本次调用的用量；`undefined` 表示端点未上报（计入不可归因计数）。
   * @returns 无返回值。
   */
  public recordModelUsage(usage: ModelUsage | undefined): void {
    // 无论有没有 usage，本次调用都**消耗**当前批次——否则上一批工具会被错并到下一批调用，
    // 让「无法归因」的调用把它的前驱工具偷走一半 token（口径错误）。
    const keys = this.drainBatch();
    if (usage === undefined) {
      this.missingUsageCalls += 1;
      return;
    }
    this.usageCalls += 1;
    const share = 1 / keys.length;
    for (const key of keys) {
      const tally = this.tallyOf(key);
      tally.promptTokens += usage.promptTokens * share;
      tally.completionTokens += usage.completionTokens * share;
      tally.cachedPromptTokens += (usage.cachedPromptTokens ?? 0) * share;
    }
  }

  /**
   * 生成归因报告。
   *
   * @returns 汇总 + 按 token 量降序的桶列表。
   */
  public build(): TokenAttributionReport {
    const buckets: TokenAttributionBucket[] = [];
    let totalTokens = 0;
    let totalPromptTokens = 0;
    let totalCompletionTokens = 0;
    let totalCachedPromptTokens = 0;
    for (const [tool, tally] of this.tallies) {
      const total = tally.promptTokens + tally.completionTokens;
      totalTokens += total;
      totalPromptTokens += tally.promptTokens;
      totalCompletionTokens += tally.completionTokens;
      totalCachedPromptTokens += tally.cachedPromptTokens;
      buckets.push({
        tool,
        toolCalls: tally.toolCalls,
        promptTokens: tally.promptTokens,
        completionTokens: tally.completionTokens,
        cachedPromptTokens: tally.cachedPromptTokens,
        totalTokens: total,
        share: 0,
      });
    }
    buckets.sort((a, b) =>
      b.totalTokens === a.totalTokens ? (a.tool < b.tool ? -1 : 1) : b.totalTokens - a.totalTokens,
    );
    return {
      totalTokens,
      totalPromptTokens,
      totalCompletionTokens,
      totalCachedPromptTokens,
      modelCallsWithUsage: this.usageCalls,
      modelCallsWithoutUsage: this.missingUsageCalls,
      buckets: buckets.map((bucket) => ({
        ...bucket,
        share: totalTokens > 0 ? bucket.totalTokens / totalTokens : 0,
      })),
    };
  }

  /**
   * 从一个会话事件流直接算出归因报告（纯投影，无副作用）。
   *
   * @param events 会话事件（顺序即时间序；通常为一条会话的 append-only 日志）。
   * @returns 归因报告。
   */
  public static fromEvents(events: readonly SessionEvent[]): TokenAttributionReport {
    const attribution = new TokenAttribution();
    for (const event of events) {
      if (event.type === 'tool_call') {
        const name = TokenAttribution.toolNameOf(event);
        if (name !== undefined) {
          attribution.recordToolCall(name);
        }
      } else if (event.type === 'model') {
        attribution.recordModelUsage(TokenAttribution.usageOf(event));
      }
    }
    return attribution.build();
  }

  /** 取出当前待归因批次的工具键集合（去重），并清空批次；空批次归入 {@link INITIAL_BUCKET}。
   * @returns 去重后的桶键数组（至少一项）。
   */
  private drainBatch(): readonly string[] {
    const keys = [...new Set(this.pendingTools)];
    this.pendingTools.length = 0;
    return keys.length > 0 ? keys : [INITIAL_BUCKET];
  }

  /** 取（或建）某桶的累计器。
   * @param key 桶键（工具名或 {@link INITIAL_BUCKET}）。
   * @returns 可变累计器。
   */
  private tallyOf(key: string): TokenAttributionTally {
    const existing = this.tallies.get(key);
    if (existing !== undefined) {
      return existing;
    }
    const created: TokenAttributionTally = {
      toolCalls: 0,
      promptTokens: 0,
      completionTokens: 0,
      cachedPromptTokens: 0,
    };
    this.tallies.set(key, created);
    return created;
  }

  /** 从 `tool_call` 事件取工具名（payload 形状异常时返回 undefined，绝不猜）。
   * @param event 会话事件。
   * @returns 工具名；payload 非法时为 undefined。
   */
  private static toolNameOf(event: SessionEvent): string | undefined {
    const payload = TokenAttribution.asRecord(event.payload);
    const name = payload?.['name'];
    return typeof name === 'string' && name.length > 0 ? name : undefined;
  }

  /** 从 `model` 事件取用量（形状异常 / 缺关键字段时返回 undefined，绝不补零）。
   * @param event 会话事件。
   * @returns 模型用量；payload 非法时为 undefined。
   */
  private static usageOf(event: SessionEvent): ModelUsage | undefined {
    const payload = TokenAttribution.asRecord(event.payload);
    const usage = TokenAttribution.asRecord(payload?.['usage']);
    if (usage === undefined) {
      return undefined;
    }
    const promptTokens = TokenAttribution.finiteNumber(usage['promptTokens']);
    const completionTokens = TokenAttribution.finiteNumber(usage['completionTokens']);
    if (promptTokens === undefined || completionTokens === undefined) {
      return undefined;
    }
    const totalTokens = TokenAttribution.finiteNumber(usage['totalTokens']);
    const cached = TokenAttribution.finiteNumber(usage['cachedPromptTokens']);
    return {
      promptTokens,
      completionTokens,
      totalTokens: totalTokens ?? promptTokens + completionTokens,
      ...(cached !== undefined ? { cachedPromptTokens: cached } : {}),
    };
  }

  /** 取有限数字（NaN / Infinity / 非数字一律视为缺失）。
   * @param value 待检值。
   * @returns 有限数字；否则 undefined。
   */
  private static finiteNumber(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
  }

  /** 把 unknown 收窄为普通对象记录（数组 / null / 原始值一律拒绝）。
   * @param value 待收窄值。
   * @returns 对象记录；否则 undefined。
   */
  private static asRecord(value: unknown): Record<string, unknown> | undefined {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return undefined;
    }
    return value as Record<string, unknown>;
  }
}
