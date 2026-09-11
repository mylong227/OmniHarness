/**
 * I-P3-3 对称破缺算子引擎（Symmetry Breaking）。
 *
 * 以**经验密度（使用非对称度）为序参量 ρ**：ρ = 占优能力的归一化主导度（最大权重 / 总权重）。
 * 越过阈值 → 从"对称态"破缺为占优能力的"非对称态"（即可被 I-P2-5 固化）。本引擎是相变
 * **可观测**算子，只检测/report，不自行固化技能（固化职责在 CapabilityCrystallizer）。
 *
 * fail-closed：已破缺后保持破缺（迟滞），不随单次低样本回弹；须显式 reset 才回对称态。
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

export class SymmetryBreakingEngine implements SymmetryBreakingPort {
  public readonly name = 'symmetry-breaking';
  private readonly threshold: number;
  private readonly group: string;
  private weights = new Map<string, number>();
  private broken = false;
  private lastTransitioned = false;

  public constructor(opts: SymmetryBreakingOptions = {}) {
    this.threshold = opts.threshold ?? 0.7;
    this.group = opts.symmetryGroup ?? 'capability-symmetry';
  }

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

  public reset(): void {
    this.weights.clear();
    this.broken = false;
  }

  /** 计算 ρ（占优能力主导度）与占优能力。 */
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
