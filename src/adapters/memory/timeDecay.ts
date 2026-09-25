import type { MemoryFact } from '../../ports/memory/longTermMemory.js';

/**
 * TimeDecay —— 由本文件原顶层函数归并而来（每个方法对应一个原函数，语义与签名逐字保留）。
 */
export class TimeDecay {
  /**
   * 计算一条事实的时间衰减因子：越旧衰减越多；过期时间、非法时间、非正半衰期均按 1（不衰减）处理。
   * 公式：`0.5^(年龄毫秒 / (半衰期天 × 日毫秒))`，即每过一个半衰期相关性减半。
   *
   * @param createdAt 事实创建时间（ISO）
   * @param nowMs 当前时间戳（毫秒）
   * @param halfLifeDays 半衰期（天），≤0 视为永久不衰减
   * @returns 衰减因子，取值 (0,1]
   */
  public static decayFactor(createdAt: string, nowMs: number, halfLifeDays: number): number {
    const created = Date.parse(createdAt);
    if (!Number.isFinite(created) || halfLifeDays <= 0) return 1;
    const ageMs = nowMs - created;
    if (ageMs <= 0) return 1;
    return Math.pow(0.5, ageMs / (halfLifeDays * DAY_MS));
  }

  /**
   * 判断一条事实是否已失效（到点）。无 `expiresAt` 或解析失败视为未失效。
   *
   * @param fact 记忆事实
   * @param nowMs 当前时间戳（毫秒）
   * @returns 已过期返回 true
   */
  public static isExpired(fact: MemoryFact, nowMs: number): boolean {
    if (fact.expiresAt === undefined) return false;
    const exp = Date.parse(fact.expiresAt);
    return Number.isFinite(exp) && exp <= nowMs;
  }

  /**
   * 把相关性得分按时间衰减重排：过滤失效事实，乘以衰减因子后降序取 top-k。
   *
   * 这是「记忆条目带时间维度」的核心——让陈旧但不冲突的事实自然退场，
   * 重排期（文件移动等）被推翻的旧事实不压过新事实（Ghost Memory 防护）。
   *
   * @param items 候选事实（含相关性得分）
   * @param nowMs 当前时间戳（毫秒）
   * @param halfLifeDays 半衰期（天）
   * @param k 取回条数
   * @returns 重排后的事实序列（已由衰减得分降序）
   */
  public static rankWithDecay(
    items: readonly ScoredFact[],
    nowMs: number,
    halfLifeDays: number,
    k: number,
  ): MemoryFact[] {
    return items
      .filter((it) => !TimeDecay.isExpired(it.fact, nowMs))
      .map((it) => ({
        fact: it.fact,
        score: it.score * TimeDecay.decayFactor(it.fact.createdAt, nowMs, halfLifeDays),
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.max(0, k))
      .map((it) => it.fact);
  }
}

/** 带原始相关性分值的记忆事实（时间衰减前）。 */
export interface ScoredFact {
  /** 记忆事实。 */
  readonly fact: MemoryFact;
  /** 相关性分值（BM25 / 共振度等，未经时间衰减）。 */
  readonly score: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;
