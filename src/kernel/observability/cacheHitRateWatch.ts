/**
 * 提示缓存**命中率坍塌**观测器（缺口 C：让命中率不再「数值错了也无人知道」）。
 *
 * 背景：`ContextUsageService` 已能从会话事件回放里算出**实测**平均命中率
 * （`Σ cached / Σ prompt`，按 token 加权），但此前**没有任何地方对该数字作出反应**——
 * 命中率掉到 0 也只是 UI 上一行小字。本类把「什么算坍塌」这一判断收成一处**纯函数**，
 * 由服务在算完统计后调用，超阈值即产出一条 warn 级结构化日志（事件名 `model.cache.lowHitRate`）。
 *
 * 口径（刻意保守，避免噪声告警）：
 *  1. **只统计上报了缓存字段的调用**（`calls` 已由上游如此定义）。端点压根不上报缓存字段时
 *     `calls` 恒为 0，本观测器静默——「端点不支持」不该被读成「缓存坏了」。
 *  2. 调用数不足 `MIN_CALLS_FOR_JUDGEMENT`（5）时静默：3 次调用里的命中率方差极大，
 *     早报只会训练运维忽略该告警。5 次是「至少跨过一轮 system+tools 的重复前缀」的量级。
 *  3. `hitRate` 缺省（无上报调用）或 `promptTokens` 为 0 时静默：没有可比的分母就无可判定。
 *  4. **只告警不阻断**：绝不因命中率低而抛错、拒绝模型调用或改变业务结果。
 *
 * 阈值 `OMNI_CACHE_HIT_WARN`（百分比 0–100）：
 *  默认 **50**。依据——缓存命中的**唯一直接收益是成本**。当前定价表里各模型的缓存输入价约为
 *  原价的 1/3（如 deepseek-chat 0.27→0.07、claude-3-5-sonnet 3→0.3、gpt-4o 2.5→1.25，见
 *  `routePricing.ts`），故命中率 p 的成本相对无缓存为 `(1-p) + p/3`；p=50% 时约为原价的 67%
 *  （省 33%）。**低于 50% 意味着连「打折三分之一」这个基本盘都没拿到**，此时长会话的
 *  增量前缀复用大概率失效（断点缺失 / 前缀含动态字节 / 端点不支持），值得人看一眼。
 *  设成 20% 则要等成本几乎全损才报，设成 80% 会让所有正当会话常年飘红。
 */

import { log } from '../util/logger.ts';
import { CacheMissAttributionAnalyst, type CacheMissCause } from './cacheMissAttributionAnalyst.ts';

/** 判定缓存命中率坍塌所需的**最少**调用数（低于此数不判定，避免小样本噪声）。 */
export const MIN_CALLS_FOR_JUDGEMENT = 5;

/** 默认告警阈值（百分比，0–100）。依据见文件头注释。 */
export const DEFAULT_LOW_HIT_RATE_THRESHOLD = 50;

/** 阈值环境变量名（可覆盖默认值，非法值回落默认值）。 */
export const LOW_HIT_RATE_ENV_KEY = 'OMNI_CACHE_HIT_WARN';

/** 命中率坍塌观测事件名（结构化日志字段 `msg`）。 */
export const LOW_HIT_RATE_EVENT = 'model.cache.lowHitRate';

/** 观测器输入：与 `ContextCacheStat` 结构兼容（只读这 4 个数）。 */
export interface CacheHitRateSample {
  /** 参与统计的输入 token 总数。 */
  readonly promptTokens: number;
  /** 其中命中缓存的 token 数。 */
  readonly cachedPromptTokens: number;
  /** 上报了缓存字段的调用次数。 */
  readonly calls: number;
  /** 平均命中率（0–100，一位小数）；无上报调用时缺省。 */
  readonly hitRate?: number | undefined;
  /**
   * 可选分因信号（2026-10-11「缓存命中率分因」）：给出时才做归因，缺省不猜。
   * 见 {@link CacheMissAttributionAnalyst.attribute}——`cachedPromptTokens` 为 `undefined`
   * 时判 `not-reported`（"没读数"≠"没命中"）。
   */
  readonly cachedPromptTokensReported?: number | undefined;
  /** 相邻请求公共前缀占比（0–1）；缺省＝未知。 */
  readonly prefixReuseRatio?: number | undefined;
  /** 距上次请求间隔（毫秒）；缺省＝未知。 */
  readonly gapMs?: number | undefined;
  /** provider 缓存 TTL（毫秒）；缺省取分因器的默认值。 */
  readonly ttlMs?: number | undefined;
  /**
   * 调用方**已算好**的分因（2026-10-15）。
   *
   * 为什么允许透传：容量面板与服务日志必须给出**同一句**结论。面板侧手上有
   * 「最近一次上报调用自己的 token + 前缀复用率 + 间隔」这些逐条信号，而观测器只拿得到会话聚合数字
   * ——若两边各自归因，同一场会话会出现两个不同的 `cause`。给了就用它，没给才按下面的原始数字自行归因。
   */
  readonly attribution?: { readonly cause: CacheMissCause; readonly reason: string } | undefined;
}

/** 坍塌判定的结果（用于日志与单测断言，不做业务分支）。 */
export interface CacheHitRateBreach {
  /** 本次判定用的实测命中率（0–100）。 */
  readonly hitRate: number;
  /** 参与统计的输入 token 总数。 */
  readonly promptTokens: number;
  /** 命中 token 数（已钳制）。 */
  readonly cachedPromptTokens: number;
  /** 上报了缓存字段的调用次数。 */
  readonly calls: number;
  /** 生效阈值（0–100）。 */
  readonly threshold: number;
  /** 可直接作日志字段的事件名。 */
  readonly event: string;
  /** 未命中分因（2026-10-11）：把"0%"变成可行动结论；无信号时按 `cachedPromptTokens` 推断。 */
  readonly cause: CacheMissCause;
  /** 分因的一句话理由（含具体数字）。 */
  readonly reason: string;
}

/**
 * 缓存命中率坍塌观测器：判定 + 发 warn 级结构化日志（无状态，可并发复用）。
 */
export class CacheHitRateWatch {
  /**
   * @param threshold 生效阈值（0–100，百分比）。缺省取 `OMNI_CACHE_HIT_WARN`，再缺省 50。
   */
  public constructor(private readonly threshold: number = CacheHitRateWatch.thresholdFromEnv()) {}

  /**
   * thresholdFromEnv — 读环境变量阈值：合法（有限数，0–100）则用，否则回落默认值。
   * 空串 / 纯空白按「未配置」处理——`Number('   ') === 0` 会把一个手滑的空格
   * 静默变成「阈值 0（永不告警）」，必须显式排除。
   * @returns 生效阈值（0–100）。
   */
  public static thresholdFromEnv(): number {
    const raw = process.env[LOW_HIT_RATE_ENV_KEY];
    if (raw === undefined) return DEFAULT_LOW_HIT_RATE_THRESHOLD;
    const trimmed = raw.trim();
    if (trimmed === '') return DEFAULT_LOW_HIT_RATE_THRESHOLD;
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) {
      return DEFAULT_LOW_HIT_RATE_THRESHOLD;
    }
    return parsed;
  }

  /**
   * evaluate — 判定是否坍塌。**纯判定**，不发日志（便于单测穷举边界）。
   * @param sample 本次会话的缓存统计。
   * @returns 命中坍塌时返回判定详情；调用数不足 / 无分母 / 命中率达标时返回 undefined。
   */
  public evaluate(sample: CacheHitRateSample): CacheHitRateBreach | undefined {
    const hitRate = sample.hitRate;
    if (hitRate === undefined || !Number.isFinite(hitRate)) return undefined;
    if (sample.promptTokens <= 0) return undefined;
    if (sample.calls < MIN_CALLS_FOR_JUDGEMENT) return undefined;
    if (hitRate >= this.threshold) return undefined;
    // 分因：**优先用调用方算好的结论**（面板与日志同源）；没有才按原始数字自行归因——
    // `cachedPromptTokensReported` 缺省时传 `undefined` ⇒ 分因器判 `not-reported`
    //（"端点没给字段"），这正是最该与"缓存全没命中"区分开的那一类。
    const attribution =
      sample.attribution ??
      CacheMissAttributionAnalyst.attribute({
        cachedPromptTokens: sample.cachedPromptTokensReported,
        promptTokens: sample.promptTokens,
        ...(sample.prefixReuseRatio !== undefined
          ? { prefixReuseRatio: sample.prefixReuseRatio }
          : {}),
        ...(sample.gapMs !== undefined ? { gapMs: sample.gapMs } : {}),
        ...(sample.ttlMs !== undefined ? { ttlMs: sample.ttlMs } : {}),
      });
    return {
      hitRate,
      promptTokens: sample.promptTokens,
      cachedPromptTokens: sample.cachedPromptTokens,
      calls: sample.calls,
      threshold: this.threshold,
      event: LOW_HIT_RATE_EVENT,
      cause: attribution.cause,
      reason: attribution.reason,
    };
  }

  /**
   * inspect — 判定并在坍塌时发一条 warn 级结构化日志（带四个数字 + 生效阈值）。
   * 只观察不阻断：调用方拿到 undefined 或 breach 都不改变业务结果；
   * 日志写入本身也 try/catch 吞掉——观测绝不允许反过来打断被观测的业务。
   * @param sample 本次会话的缓存统计。
   * @returns 判定详情（未坍塌时为 undefined）。
   */
  public inspect(sample: CacheHitRateSample): CacheHitRateBreach | undefined {
    const breach = this.evaluate(sample);
    if (breach === undefined) return undefined;
    try {
      log.warn(LOW_HIT_RATE_EVENT, {
        hitRate: breach.hitRate,
        promptTokens: breach.promptTokens,
        cachedPromptTokens: breach.cachedPromptTokens,
        calls: breach.calls,
        threshold: breach.threshold,
        // 分因（2026-10-11）：把"0%"变成可行动结论——日志里直接给 cause + 一句话理由。
        cause: breach.cause,
        reason: breach.reason,
      });
    } catch {
      // 观测路径 fail-soft：sink 抛错（stderr 关闭 / 自定义 sink 故障）不得影响调用方。
    }
    return breach;
  }
}
