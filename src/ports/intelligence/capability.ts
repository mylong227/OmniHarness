/**
 * 相变固化端口（P2, I-P2-5）。
 *
 * 微观粒子/对称破缺隐喻（Higgs 相变）：以"经验密度"为序参量，当某个技能组合的
 * 使用密度越过临界阈值，该"常用组合"便冻结成一条稳定的原生能力（一次组合、永久可用，
 * 不再每次临时重新组合）。冻结是**加法式**——只新增原生能力，绝不删改源组合或既有能力
 * （fail-closed）。
 */

export type { FrozenCapability } from './capability/frozenCapability.js';
export type { CrystallizationReport } from './capability/crystallizationReport.js';
export type { CapabilityCrystallizerPort } from './capability/capabilityCrystallizerPort.js';
