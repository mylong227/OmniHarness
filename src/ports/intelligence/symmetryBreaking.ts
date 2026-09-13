/**
 * I-P3-3 对称破缺算子（Symmetry Breaking）端口。
 *
 * Higgs 1964 PRL 13:508：以**经验密度（使用非对称度）为序参量 ρ**，越过阈值时常用组合
 * 从"对称态"破缺为占优的"非对称态"（冻结为稳定原生能力）。本端口是相变**可观测**算子——
 * 它检测并报告相变，而非自行固化技能（固化由 I-P2-5 CapabilityCrystallizer 完成，二者同源）。
 *
 * fail-closed：已破缺后保持破缺（迟滞），不随单次低样本回弹；须显式 reset 才回对称态。
 */

/** 对称态。 */
export type SymmetryState = 'symmetric' | 'broken';

/** 单次使用样本。 */
export interface UsageSample {
  /** 能力标识。 */
  readonly capability: string;
  /** 使用权重（经验密度贡献）。 */
  readonly weight: number;
}

/** 对称破缺快照报告（能力相变可观测）。 */
export interface SymmetryBreakReport {
  /** 序参量 ρ（占优能力的归一化主导度 0..1）。 */
  readonly orderParameter: number;
  /** 当前对称态。 */
  readonly state: SymmetryState;
  /** 破缺后占优的能力标识（对称态为 undefined）。 */
  readonly brokenState?: string | undefined;
  /** 被破缺的对称群标签。 */
  readonly symmetryGroup: string;
  /** 本次 observe 是否跨越阈值（发生相变）。 */
  readonly transitioned: boolean;
}

/** 对称破缺端口。 */
export interface SymmetryBreakingPort {
  readonly name: string;
  /**
   * 观测一次使用样本，推进序参量 ρ。
   * 返回本次是否发生相变（对称→破缺）。fail-closed：空样本不推进、不抛错。
   */
  observe(usage: readonly UsageSample[]): boolean;
  /** 当前对称态快照（能力相变可观测）。 */
  snapshot(): SymmetryBreakReport;
  /** 重置序参量，回到对称态。 */
  reset(): void;
}
