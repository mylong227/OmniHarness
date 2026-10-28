/**
 * 间隔效应（Spacing Effect）—— Ebbinghaus 遗忘曲线 + 间隔重复（FSRS-lite）的纯函数层。
 *
 * ## 机制来源（生物学/心理学规律 → 记忆系统）
 *
 * Ebbinghaus (1885) 实测：记忆保持率随时间呈**指数衰减** `R(t) = 0.5^(t/S)`，
 * S 为「记忆稳定度」。间隔重复（spaced repetition，SuperMemo/FRS/FSRS 一系）的两大结论：
 *  1. **合意困难**（desirable difficulty）：在接近遗忘（低保留率 R）时成功回忆一次，
 *     稳定度的**增益最大**——`S' = S × (1 + g × (1 - R))`；
 *  2. **稳定度个体化**：重要的事实应衰减更慢（初值随 importance 放大），
 *     且被反复召回的事实越来越抗遗忘。
 *
 * ## 与既有 TimeDecay 的关系（为什么不是替换而是升级）
 *
 * `TimeDecay` 用**全局统一**半衰期（默认 90 天）从 `createdAt` 起算——所有事实一视同仁，
 * 召回历史不产生任何影响。本模块把它升级为**每条独立**：
 *  - 初值锚点：`S0 = 30 × importance` 天（importance 3 ⇒ 90 天，与旧全局值同锚，
 *    默认参数下单条事实的首日行为与旧实现一致）；
 *  - 时间锚点：`lastRecallAt ?? createdAt`（被召回过的事实从上次召回起算）；
 *  - 强化：召回命中即 `S' = S × (1 + (1 - R))`（g=1），上限 10 年；
 *    60 秒内重复召回不重复强化（同一会话内 primer 多次组装不刷次数）。
 *
 * ## 诚实边界（预注册）
 *
 * - 这是**机制级**实现：判据证明数学性质与排序效果（确定性注入时钟），
 *   **不**外推为「生产增益」——增益测量需经 `tools/probes/recallHitrate` 在固定语料上
 *   对照（`OMNI_MEMORY_FORGETTING=1` vs 关），两关显著才允许默认开启（当前**默认关**）。
 * - 未做： FSRS 的完整参数拟合（w 系数向量）、按难度分级的多级间隔、失败召回的稳定度回退。
 */
import type { MemoryFact } from '../../ports/memory/longTermMemory.ts';
import { TimeDecay } from './timeDecay.ts';

/** 一天毫秒数。 */
const DAY_MS = 24 * 60 * 60 * 1000;

/** 间隔重复的最小强化间隔（毫秒）：60 秒内的重复召回不重复强化。 */
const REINFORCE_MIN_INTERVAL_MS = 60_000;

/** 稳定度上限（天）：10 年，防数值发散。 */
const MAX_STABILITY_DAYS = 3650;

/** 一条待强化事实的记账（召回命中后由存储层转成补丁写回）。 */
export interface Reinforcement {
  /** 事实 id。 */
  readonly id: string;
  /** 召回时的保留率 R ∈ (0,1]（强化增益的依据）。 */
  readonly retention: number;
}

/**
 * 间隔效应计算（纯函数集合，无模块级可变状态）。
 */
export class SpacingEffect {
  /**
   * 稳定度初值：`30 × importance` 天（importance 3 ⇒ 90 天，与旧全局半衰期同锚）。
   * @param importance 重要度 1..5（越界夹紧）。
   * @returns 稳定度（天）。
   */
  public static initialStabilityDays(importance: number): number {
    const clamped = Math.min(5, Math.max(1, Math.round(importance)));
    return 30 * clamped;
  }

  /**
   * 一条事实的有效稳定度（天）：已强化过的用 `stabilityDays`，否则按重要度取初值。
   * @param fact 记忆事实。
   * @returns 稳定度（天）。
   */
  public static stabilityOf(fact: MemoryFact): number {
    if (
      fact.stabilityDays !== undefined &&
      Number.isFinite(fact.stabilityDays) &&
      fact.stabilityDays > 0
    ) {
      return fact.stabilityDays;
    }
    return SpacingEffect.initialStabilityDays(fact.importance);
  }

  /**
   * 时间锚点毫秒：`lastRecallAt ?? createdAt`（不可解析时回落 0，保留率按 1）。
   * @param fact 记忆事实。
   * @returns 锚点毫秒时间戳。
   */
  public static anchorMsOf(fact: MemoryFact): number {
    const raw = fact.lastRecallAt ?? fact.createdAt;
    const parsed = Date.parse(raw);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  /**
   * 保留率：`0.5^(elapsed / (S × 日毫秒))`；时间倒流/非法输入按 1（不衰减）。
   * @param nowMs 当前毫秒。
   * @param anchorMs 锚点毫秒。
   * @param stabilityDays 稳定度（天）。
   * @returns 保留率 R ∈ (0,1]。
   */
  public static retention(nowMs: number, anchorMs: number, stabilityDays: number): number {
    if (!Number.isFinite(anchorMs) || anchorMs <= 0 || stabilityDays <= 0) return 1;
    const elapsed = nowMs - anchorMs;
    if (elapsed <= 0) return 1;
    return Math.pow(0.5, elapsed / (stabilityDays * DAY_MS));
  }

  /**
   * 强化后的稳定度（合意困难）：`S' = S × (1 + g×(1-R))`，g=1，上限 {@link MAX_STABILITY_DAYS}。
   * @param stabilityDays 当前稳定度（天）。
   * @param retention 召回时保留率 R ∈ (0,1]。
   * @returns 新稳定度（天，≥ 原值）。
   */
  public static reinforcedStability(stabilityDays: number, retention: number): number {
    const safeR = Number.isFinite(retention) ? Math.min(1, Math.max(0, retention)) : 1;
    const grown = stabilityDays * (1 + (1 - safeR));
    return Math.min(MAX_STABILITY_DAYS, Math.max(stabilityDays, grown));
  }

  /**
   * 是否应为本条记账强化：60 秒内已强化过的不重复（防同一会话反复组装 primer 刷次数）。
   * @param fact 记忆事实。
   * @param nowMs 当前毫秒。
   * @returns 应强化为 true。
   */
  public static shouldReinforce(fact: MemoryFact, nowMs: number): boolean {
    if (fact.lastRecallAt === undefined) return true;
    const last = Date.parse(fact.lastRecallAt);
    if (!Number.isFinite(last)) return true;
    return nowMs - last > REINFORCE_MIN_INTERVAL_MS;
  }

  /**
   * 间隔重复版重排：`expiresAt` 过滤（与 TimeDecay 同口径）→ 按每条独立稳定度算保留率 →
   * 得分 × R × untrusted 惩罚 → 降序取 top-k，并对命中条目产出强化记账。
   * @param items 候选（含原始相关性分）。
   * @param nowMs 当前毫秒。
   * @param k 取回条数。
   * @param untrustedPenalty 不可信来源惩罚（0..1）。
   * @returns 排序结果 + 待强化记账（调用方转补丁写回）。
   */
  public static rankWithSpacing(
    items: readonly { readonly fact: MemoryFact; readonly score: number }[],
    nowMs: number,
    k: number,
    untrustedPenalty = 1,
  ): { readonly ranked: MemoryFact[]; readonly reinforcements: readonly Reinforcement[] } {
    const penalty = Number.isFinite(untrustedPenalty)
      ? Math.min(1, Math.max(0, untrustedPenalty))
      : 1;
    const scored = items
      .filter((it) => !TimeDecay.isExpired(it.fact, nowMs))
      .map((it) => {
        const anchor = SpacingEffect.anchorMsOf(it.fact);
        const stability = SpacingEffect.stabilityOf(it.fact);
        const retention = SpacingEffect.retention(nowMs, anchor, stability);
        return {
          fact: it.fact,
          score: it.score * retention * (it.fact.trust === 'untrusted' ? penalty : 1),
          retention,
        };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.max(0, k));
    const reinforcements: Reinforcement[] = [];
    for (const entry of scored) {
      if (SpacingEffect.shouldReinforce(entry.fact, nowMs)) {
        reinforcements.push({ id: entry.fact.id, retention: entry.retention });
      }
    }
    return { ranked: scored.map((entry) => entry.fact), reinforcements };
  }
}
