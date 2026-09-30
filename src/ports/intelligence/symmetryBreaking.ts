/**
 * I-P3-3 对称破缺算子（Symmetry Breaking）端口。
 *
 * Higgs 1964 PRL 13:508：以**经验密度（使用非对称度）为序参量 ρ**，越过阈值时常用组合
 * 从"对称态"破缺为占优的"非对称态"（冻结为稳定原生能力）。本端口是相变**可观测**算子——
 * 它检测并报告相变，而非自行固化技能（固化由 I-P2-5 CapabilityCrystallizer 完成，二者同源）。
 *
 * fail-closed：已破缺后保持破缺（迟滞），不随单次低样本回弹；须显式 reset 才回对称态。
 *
 * 本文件已退化为桶：4 个接口各自独立成文件于 `./symmetryBreaking/`，调用点零改动。
 */

export type { SymmetryState } from './symmetryBreaking/symmetryState.js';
export type { UsageSample } from './symmetryBreaking/usageSample.js';
export type { SymmetryBreakReport } from './symmetryBreaking/symmetryBreakReport.js';
export type { SymmetryBreakingPort } from './symmetryBreaking/symmetryBreakingPort.js';
