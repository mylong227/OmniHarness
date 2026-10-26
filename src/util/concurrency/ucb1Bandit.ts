/**
 * UCB1 多臂老虎机（Auer et al., 2002）——**有界 regret** 的自适应模型路由。
 *
 * 每次选择：
 *
 * ```text
 * score_i = mean_i + sqrt(2 · ln(N) / n_i)
 * ```
 *
 * `mean_i` 利用已知表现，`sqrt(...)` 是对探索少的手臂的置信上界；冷启动时每个手臂先各试一次。
 * 奖励归一到 [0,1]（本仓用 `success / (1 + latencySeconds)`），失败臂得 0 且会被快速降权，
 * 但上界项保证它不会被永久放弃（非平稳环境可重新探测）。
 *
 * @maturity L2 — 真实 UCB1 选择/奖励累计；未做滑动窗口非平稳重置与上下文分桶
 * @maturityEvidence tests/unit/ucb1Bandit.test.ts
 */

/** 单臂统计。 */
export interface Ucb1ArmStats {
  /** 选择次数。 */
  readonly pulls: number;
  /** 奖励总和。 */
  readonly rewardSum: number;
  /** 平均奖励（0 pulls 时为 0）。 */
  readonly mean: number;
}

/** UCB1 选择器。 */
export class Ucb1Bandit {
  /** 各臂 pull 数。 */
  private readonly pulls: number[];
  /** 各臂奖励和。 */
  private readonly rewards: number[];
  /** 总 pull 数。 */
  private total = 0;

  /**
   * @param armCount 臂数（≥1）。
   */
  public constructor(private readonly armCount: number) {
    if (!Number.isInteger(armCount) || armCount < 1) throw new Error('armCount 必须 ≥1');
    this.pulls = Array.from({ length: armCount }, () => 0);
    this.rewards = Array.from({ length: armCount }, () => 0);
  }

  /**
   * 选择下一个臂下标（冷启动按顺序探索；之后取 UCB 最大，平局取小下标）。
   * @returns 臂下标。
   */
  public select(): number {
    for (let index = 0; index < this.armCount; index += 1) {
      if ((this.pulls[index] ?? 0) === 0) return index;
    }
    const logTotal = Math.log(Math.max(1, this.total));
    let best = 0;
    let bestScore = -Infinity;
    for (let index = 0; index < this.armCount; index += 1) {
      const pulls = this.pulls[index] ?? 0;
      const mean = (this.rewards[index] ?? 0) / pulls;
      const score = mean + Math.sqrt((2 * logTotal) / pulls);
      if (score > bestScore) {
        bestScore = score;
        best = index;
      }
    }
    return best;
  }

  /**
   * 记录奖励（夹取到 [0,1]）。
   * @param arm 臂下标。
   * @param reward 奖励（非有限值按 0）。
   * @returns 无返回值。
   */
  public record(arm: number, reward: number): void {
    if (!Number.isInteger(arm) || arm < 0 || arm >= this.armCount) {
      throw new RangeError(`arm=${String(arm)} 越界`);
    }
    const clamped = Number.isFinite(reward) ? Math.min(1, Math.max(0, reward)) : 0;
    this.pulls[arm] = (this.pulls[arm] ?? 0) + 1;
    this.rewards[arm] = (this.rewards[arm] ?? 0) + clamped;
    this.total += 1;
  }

  /**
   * 某臂统计。
   * @param arm 臂下标。
   * @returns 统计。
   */
  public statsOf(arm: number): Ucb1ArmStats {
    const pulls = this.pulls[arm] ?? 0;
    const rewardSum = this.rewards[arm] ?? 0;
    return { pulls, rewardSum, mean: pulls === 0 ? 0 : rewardSum / pulls };
  }

  /**
   * 总选择次数。
   * @returns 总 pull 数。
   */
  public totalPulls(): number {
    return this.total;
  }
}
