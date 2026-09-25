/**
 * 退火接受（T5.3 · RLVR 训练信号）。
 *
 * 解决的问题：(1+1)-EA 的**贪心接受**（劣解一律拒绝）在多峰空间容易困死在局部最优；
 * 允许以「温度调度的概率」接受小劣解（模拟退火经典结论），在窄域进化里是免费增益。
 *
 * 可复现性纪律：接受随机数来自**种子化 PRNG**（mulberry32，复用 bootstrap 的实现），
 * 同种子 + 同事件序列恒同接受序列——门禁/评测可以精确重放，不存在随机红绿。
 *
 * @maturity L1 — 接受概率公式为标准模拟退火 Metropolis 准则；「免费增益」依赖搜索空间，本模块只提供机制
 * @maturityEvidence tests/unit/annealedAcceptance.test.ts
 */
import { Bootstrap } from '../eval/bootstrap.js';

/** 退火接受选项。 */
export interface AnnealedAcceptanceOptions {
  /** 种子（默认 20260913；同种子恒同序列）。 */
  readonly seed?: number;
  /** 初始温度 T0（默认 1.0；温度越高越容易接受劣解）。 */
  readonly initialTemperature?: number;
  /** 每次接受的冷却系数（0..1，1 = 恒温；默认 0.95）。 */
  readonly cooling?: number;
}

/** 一次接受判定的记录（审计/重放用）。 */
export interface AcceptanceDecision {
  /** 是否接受候选。 */
  readonly accepted: boolean;
  /** 判定时温度。 */
  readonly temperature: number;
  /** 劣解被接受的概率（劣解时 = exp(−Δ/T)；优解恒 1）。 */
  readonly probability: number;
}

/**
 * 退火接受器：对「fitness 越高越好」的候选流做接受判定。
 * - 候选不劣于当前 → 接受（概率 1，不消耗随机数）；
 * - 候选更劣 → 以 exp(−Δ/T) 概率接受（Δ = 当前 − 候选，>0）；
 * - 每次判定后温度 ×= cooling（单调不升）。
 */
export class AnnealedAcceptance {
  /** 种子化随机源（mulberry32；同种子恒同序列）。 */
  private readonly rng: () => number;
  /** 冷却系数（每次判定后温度 ×= cooling）。 */
  private readonly cooling: number;
  /** 当前温度（单调不升）。 */
  private _temperature: number;

  /**
   * @param opts 种子 / 初始温度 / 冷却系数
   */
  public constructor(opts: AnnealedAcceptanceOptions = {}) {
    this.rng = Bootstrap.mulberry32(opts.seed ?? 20260913);
    this._temperature = Math.max(1e-6, opts.initialTemperature ?? 1.0);
    this.cooling = Math.min(1, Math.max(0.01, opts.cooling ?? 0.95));
  }

  /** 当前温度（单调不升）。 */
  public get temperature(): number {
    return this._temperature;
  }

  /**
   * 判定是否接受候选。
   * @param current 当前（ incumbent）适应度
   * @param candidate 候选适应度
   * @returns 接受判定记录
   */
  public decide(current: number, candidate: number): AcceptanceDecision {
    const t = this._temperature;
    const delta = current - candidate; // >0 表示候选更劣
    if (delta <= 0) {
      this._temperature *= this.cooling;
      return { accepted: true, temperature: t, probability: 1 };
    }
    const p = Math.exp(-delta / t);
    const accepted = this.rng() < p;
    this._temperature *= this.cooling;
    return { accepted, temperature: t, probability: p };
  }
}
