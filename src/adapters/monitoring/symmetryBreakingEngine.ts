/**
 * I-P3-3 对称破缺算子引擎（Symmetry Breaking）。
 *
 * 以**经验密度（使用非对称度）为序参量 ρ**：ρ = 占优能力的归一化主导度（最大权重 / 总权重）。
 * 越过阈值 → 从"对称态"破缺为占优能力的"非对称态"（即可被 I-P2-5 固化）。本引擎是相变
 * **可观测**算子，只检测/report，不自行固化技能（固化职责在 CapabilityCrystallizer）。
 *
 * fail-closed：已破缺后保持破缺（迟滞），不随单次低样本回弹；须显式 reset 才回对称态。
 *
 * @maturity L0 — 命名级；未定义序参量，无自发破缺动力学
 * @maturityEvidence tests/unit/symmetryBreaking.test.ts
 */

import type {
  SymmetryBreakingPort,
  SymmetryBreakReport,
  UsageSample,
} from '../../ports/symmetryBreaking.js';

export interface SymmetryBreakingOptions {
  /** 破缺阈值（ρ 越此值即破缺，默认 0.6）。 */
  readonly threshold?: number;
  /** 被破缺的对称群标签（默认 'capability-symmetry'）。 */
  readonly symmetryGroup?: string;
}

/** 对称破缺算子引擎：实现 {@link SymmetryBreakingPort}，检测并报告能力相变，不自行固化技能。 */
export class SymmetryBreakingEngine implements SymmetryBreakingPort {
  /** 端口名：对称破缺算子标识，与 SymmetryBreakingPort 契约的命名空间一致。 */
  public readonly name = 'symmetry-breaking';
  /** 破缺阈值（ρ 越此值即破缺；下限由调用方保证合理）。 */
  private readonly threshold: number;
  /** 对称群标签（随报告透出）。 */
  private readonly group: string;
  /** 各能力累计使用权重（序参量 ρ 的原始材料）。 */
  private weights = new Map<string, number>();
  /** 是否已破缺（迟滞：置位后不随单次低样本回弹，须显式 reset）。 */
  private broken = false;
  /** 最近一次 observe 是否发生对称 → 破缺相变。 */
  private lastTransitioned = false;

  /**
   * 构造引擎：按选项取阈值与对称群标签（缺省阈值 0.7、群 'capability-symmetry'）。
   * @param opts 可选配置。
   */
  public constructor(opts: SymmetryBreakingOptions = {}) {
    this.threshold = opts.threshold ?? 0.7;
    this.group = opts.symmetryGroup ?? 'capability-symmetry';
  }

  /**
   * 观测一批使用样本：累加各能力权重推进序参量 ρ（占优能力归一化主导度），ρ 越阈值即破缺
   * （迟滞：破缺后不随单次低样本回弹）。空样本不推进；无效权重（非正/非有限）跳过。
   * @param usage 本批使用样本（能力 + 权重）。
   * @returns 本次是否跨越阈值发生相变（对称 → 破缺）。
   */
  public observe(usage: readonly UsageSample[]): boolean {
    if (usage.length === 0) return false;
    for (const u of usage) {
      if (!u.capability || !isFinite(u.weight) || u.weight <= 0) continue;
      this.weights.set(u.capability, (this.weights.get(u.capability) ?? 0) + u.weight);
    }
    const wasBroken = this.broken;
    const { rho } = this.compute();
    this.broken = rho >= this.threshold;
    this.lastTransitioned = !wasBroken && this.broken; // 仅本次跨越阈值算 transitioned
    return this.lastTransitioned;
  }

  /**
   * 当前对称态快照：返回序参量 ρ、状态（ρ 已越阈值即记为 broken）、破缺后占优能力与
   * 对称群标签（transitioned 仅为最近一次 observe 是否发生相变）。
   * @returns 能力相变可观测报告。
   */
  public snapshot(): SymmetryBreakReport {
    const { rho, dominant } = this.compute();
    const state = this.broken ? 'broken' : rho >= this.threshold ? 'broken' : 'symmetric';
    this.broken = state === 'broken';
    return {
      orderParameter: rho,
      state,
      brokenState: state === 'broken' ? dominant : undefined,
      symmetryGroup: this.group,
      transitioned: this.lastTransitioned,
    };
  }

  /** 重置序参量：清空权重累积并回到对称态（显式回滚，非自动回弹）。
   * @returns 无返回值。
   */
  public reset(): void {
    this.weights.clear();
    this.broken = false;
  }

  /** 计算 ρ（占优能力主导度）与占优能力。
   * @returns rho = 最大权重 / 总权重（无权重时为 0），dominant 为权重最大的能力名（可能 undefined）。
   */
  private compute(): { rho: number; dominant: string | undefined } {
    let total = 0;
    let dominant: string | undefined;
    let max = 0;
    for (const [cap, w] of this.weights) {
      total += w;
      if (w > max) {
        max = w;
        dominant = cap;
      }
    }
    const rho = total > 0 ? max / total : 0;
    return { rho, dominant };
  }
}
