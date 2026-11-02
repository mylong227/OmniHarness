/**
 * 提示缓存**未命中的分因**（2026-10-11，目标项「缓存命中率分因」）。
 *
 * ## 为什么需要它
 *
 * 会话面板与告警此前只会报一个数字：`命中率 0%`。但"0%"至少对应四种完全不同的处置：
 *
 * | 分因 | 真实含义 | 该做什么 |
 * | --- | --- | --- |
 * | `not-reported` | 端点压根没上报缓存字段（本仓 `ModelUsage.cachedPromptTokens` 缺省） | 别改提示词——先确认端点/字段；报"0%"是**假读数** |
 * | `cold-start` | 本会话第一次请求，没有可复用的前序前缀 | 什么都不用做（分母不存在） |
 * | `prefix-rewrite` | 相邻请求的**公共前缀占比**过低 ⇒ 字节级前缀被打断 | **本机可控**：查 `PrefixStability` / `canonical` 的稳定性 |
 * | `ttl-expired` | 距上次请求超过 provider 的缓存 TTL（Anthropic 默认 5min） | 外部条件：缩短间隔或接受不命中 |
 * | `unknown` | 有上报，但**信号不全**（缺前缀占比/间隔），或前缀稳定且间隔在 TTL 内 | 先分辨"没测到"与"真没问题"：前者去补信号，后者才轮到端点行为/容量/配额 |
 *
 * 本仓已分别有 `PrefixStability.prefixReuse`（前缀复用率）与 `CacheHitRateWatch`（坍塌告警）——
 * 缺的正是把两者**合成一句可行动结论**的这一层。判定优先级见 {@link CacheMissAttributionAnalyst.attribute}。
 */
import { PrefixStability } from '../context/prefixStability.ts';

/**
 * 缓存未命中的分因。
 *
 * `hit` 不是"未命中"，但它必须留在同一个枚举里：否则调用方拿到 `undefined` 时
 * 分不清"命中了"与"没信号"，又回到"一个数字说不清"的老问题。
 */
export type CacheMissCause =
  'hit' | 'not-reported' | 'cold-start' | 'prefix-rewrite' | 'ttl-expired' | 'unknown';

/** 分因所需的信号（全部来自既有观测面，本模块不采集）。 */
export interface CacheMissSignals {
  /** 端点上报的缓存命中 token 数；**undefined = 端点没上报**（与"上报了 0"不同）。 */
  readonly cachedPromptTokens?: number | undefined;
  /** 本次请求的输入 token 数（分母；≤0 时无法谈命中率）。 */
  readonly promptTokens: number;
  /** 与上一次请求的公共前缀占比（0–1，来自 `PrefixStability.prefixReuse`）；缺省＝未知。 */
  readonly prefixReuseRatio?: number | undefined;
  /** 距上一次请求的间隔（毫秒）；缺省＝未知。 */
  readonly gapMs?: number | undefined;
  /** provider 的缓存 TTL（毫秒）；缺省取 {@link CacheMissAttributionAnalyst.DEFAULT_PROMPT_CACHE_TTL_MS}。 */
  readonly ttlMs?: number | undefined;
  /** 本会话此前是否已有请求；缺省按下 `gapMs`/`prefixReuseRatio` 是否存在推断。 */
  readonly hasPreviousRequest?: boolean | undefined;
  /**
   * 本会话内**上报了缓存字段**的调用次数（0 = 一次都没有；含"尚无模型调用"）。
   *
   * 为什么需要它：`cachedPromptTokens` 缺省时，会话面板原先只能说"端点未上报缓存字段"，
   * 而"还没跑过任何模型调用"与"跑过了但端点不给字段"是两件事（前者什么都不用做）。
   * 缺省＝未知（沿用旧文案）。
   */
  readonly reportedCalls?: number | undefined;
}

/** 一次分因结果（结论 + 一句话理由 + 原始证据）。 */
export interface CacheMissAttribution {
  /** 分因。 */
  readonly cause: CacheMissCause;
  /** 可直接进日志/面板的**一句话理由**（含具体数字，便于当场核对）。 */
  readonly reason: string;
  /** 原始证据（判据与排障都读它，不含推断）。 */
  readonly evidence: Readonly<Record<string, unknown>>;
}

/** 分因器（纯静态、无状态）。 */
export class CacheMissAttributionAnalyst {
  /** 缺省 TTL：5 分钟（与 Anthropic 提示缓存的 5min 档一致；其它厂商可经 `ttlMs` 覆盖）。 */
  public static readonly DEFAULT_PROMPT_CACHE_TTL_MS = 5 * 60_000;

  /**
   * 前缀复用率的下限：低于它即判 `prefix-rewrite`。
   *
   * 取 0.9 的依据：上游只复用**字节级公共前缀**，而本仓 `PrefixStability` 的治理目标就是让
   * "常驻指令 + 事件历史"这段跨回合稳定；一旦复用率掉到九成以下，说明**尾部可变段之前**就已分叉
   * （对象键序、时间戳、临时路径这类无语义抖动），此时"未命中"几乎必然是前缀被打断，
   * 而不是 TTL —— 这是本机可控、且最该先查的一类。
   */
  public static readonly PREFIX_REUSE_FLOOR = 0.9;

  /**
   * 按**固定优先级**分因：`not-reported` > `hit` > `cold-start` > `prefix-rewrite` > `ttl-expired` > `unknown`。
   *
   * 优先级不能随意：`not-reported` 必须最先（否则"端点没给字段"会被误算成"缓存全没命中"，
   * 引导用户去改本来没问题的提示词）；`prefix-rewrite` 必须早于 `ttl-expired`
   * （前缀断了的话，TTL 再新鲜也一样不命中，而前者是本机可控的那一类）。
   * @param signals 分因信号。
   * @returns 分因结果（结论 + 理由 + 证据）。
   */
  public static attribute(signals: CacheMissSignals): CacheMissAttribution {
    const { cachedPromptTokens, promptTokens, prefixReuseRatio, gapMs } = signals;
    const ttlMs = signals.ttlMs ?? CacheMissAttributionAnalyst.DEFAULT_PROMPT_CACHE_TTL_MS;
    const evidence: Record<string, unknown> = {
      promptTokens,
      cachedPromptTokens: cachedPromptTokens ?? null,
      prefixReuseRatio: prefixReuseRatio ?? null,
      gapMs: gapMs ?? null,
      ttlMs,
    };

    // ① 端点没上报：这不是"未命中"，是"没有读数"。
    if (cachedPromptTokens === undefined) {
      const none = signals.reportedCalls === 0;
      return {
        cause: 'not-reported',
        reason: none
          ? '本会话尚无任何上报缓存的模型调用（0 次）⇒ 显示 0% 是假读数，先确认端点是否上报该字段'
          : '端点未上报缓存字段（cachedPromptTokens 缺省）⇒ 显示 0% 是假读数，先确认端点/字段',
        evidence,
      };
    }
    // ② 有命中：无需归因（但保留同一枚举，调用方无需区分 undefined 的两种含义）。
    if (cachedPromptTokens > 0) {
      return {
        cause: 'hit',
        reason: `命中 ${String(cachedPromptTokens)}/${String(promptTokens)} token`,
        evidence,
      };
    }
    // ③ 冷启动：没有前序请求，分母不存在。
    const hasPrevious =
      signals.hasPreviousRequest ?? (prefixReuseRatio !== undefined || gapMs !== undefined);
    if (!hasPrevious) {
      return {
        cause: 'cold-start',
        reason: '本会话第一次请求（无前序前缀可复用）⇒ 0% 属正常，不必处置',
        evidence,
      };
    }
    // ④ 前缀被打断：本机可控，优先报它。
    if (
      prefixReuseRatio !== undefined &&
      prefixReuseRatio < CacheMissAttributionAnalyst.PREFIX_REUSE_FLOOR
    ) {
      return {
        cause: 'prefix-rewrite',
        reason:
          `相邻请求公共前缀占比 ${prefixReuseRatio.toFixed(3)} < ${String(CacheMissAttributionAnalyst.PREFIX_REUSE_FLOOR)}` +
          ' ⇒ 前缀在字节级被改写（查 PrefixStability / canonical 的稳定性）',
        evidence,
      };
    }
    // ⑤ TTL：间隔超过 provider 的缓存有效期。
    if (gapMs !== undefined && gapMs > ttlMs) {
      return {
        cause: 'ttl-expired',
        reason: `距上次请求 ${String(gapMs)}ms > TTL ${String(ttlMs)}ms ⇒ 缓存条目已过期（外部条件）`,
        evidence,
      };
    }
    // ⑥ 有上报、但**信号不全**时不得冒充"前缀稳定"（那会把"没测到"说成"查过了"）。
    const missing: string[] = [];
    if (prefixReuseRatio === undefined) missing.push('前缀占比');
    if (gapMs === undefined) missing.push('请求间隔');
    if (missing.length > 0) {
      return {
        cause: 'unknown',
        reason: `有上报但缺${missing.join('与')}信号 ⇒ 无法归因（不是"没问题"，是"没测到"；旧会话快照不含前缀占比）`,
        evidence,
      };
    }
    // ⑦ 前缀稳定、间隔也在 TTL 内：原因不在本机可控面。
    return {
      cause: 'unknown',
      reason: '有上报且前缀稳定、间隔在 TTL 内 ⇒ 原因不在本机可控面（端点行为/容量/配额）',
      evidence,
    };
  }

  /**
   * 便捷入口：直接由两段提示文本算前缀复用率再分因（判据与排障脚本常用）。
   *
   * 复用 `PrefixStability.prefixReuse`（**唯一实现**）而不是在本地再写一遍公共前缀算法——
   * 否则"面板口径"与"治理口径"会各自漂移。
   * @param previous 上一次实际送出的提示文本。
   * @param incoming 本次提示文本。
   * @param rest 其余信号（`promptTokens` 必填）。
   * @returns 分因结果。
   */
  public static attributeFromTexts(
    previous: string,
    incoming: string,
    rest: Omit<CacheMissSignals, 'prefixReuseRatio'>,
  ): CacheMissAttribution {
    return CacheMissAttributionAnalyst.attribute({
      ...rest,
      prefixReuseRatio: PrefixStability.prefixReuse(previous, incoming),
      hasPreviousRequest: rest.hasPreviousRequest ?? true,
    });
  }
}
