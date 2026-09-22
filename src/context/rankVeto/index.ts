/**
 * 排序前置否决器 —— **域出口**（2026-09-12 拆分，2026-09-22 收进本域目录）。
 *
 * 原 `rankVeto.ts` 单文件 503 行，同时违反清单的两条标准：
 * ① 文件 >500 行（上帝类门禁）；② 主类名 `RankVetoEvaluator` ≠ 文件名 `rankVeto`。
 * 按「职责缝」拆为三块后，本文件**只做聚合再导出**，调用点无需知道内部三文件：
 *
 * | 文件 | 职责 |
 * | ---- | ---- |
 * | {@link ./rankVetoOverlap.ts} | Top-K 集合重合度量（主判据的量具） |
 * | {@link ./rankVetoSpectrum.ts} | 图结构性诊断（已被回溯验证证伪，仅报告） |
 * | {@link ./rankVetoEvaluator.ts} | 阈值、契约、判据编排（`RankVetoEvaluator`） |
 *
 * 2026-09-22 变更：本域四文件由 `src/context/` 平铺收进 `src/context/rankVeto/`。
 * 起因是 `src/context/` 平铺 `.ts` 32 个，触发架构门禁「单目录直接 .ts > 30」告警；
 * 同时「同名域归属唯一」要求 rankVeto 一族同处一域。调用点路径相应改为
 * `.../context/rankVeto/index.js`。
 *
 * 判据的来历、被证伪的经过与「放行 ≠ 有效」的局限，见 {@link ./rankVetoEvaluator.ts} 的模块头。
 *
 * @see ./rankVetoEvaluator.ts
 */

export { jaccardOverlap, meanPairwiseJaccard } from './rankVetoOverlap.js';
export { structuralDiagnostics } from './rankVetoSpectrum.js';
export type { StructuralDiagnostics, VetoGraph } from './rankVetoSpectrum.js';
export { DEFAULT_VETO_THRESHOLDS, RankVetoEvaluator } from './rankVetoEvaluator.js';
export type {
  RankVetoInput,
  RankVetoReport,
  VetoMetrics,
  VetoThresholds,
} from './rankVetoEvaluator.js';
