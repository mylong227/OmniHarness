/**
 * 排序前置否决器 —— **兼容门面**（2026-09-12 拆分后保留）。
 *
 * 原 `rankVeto.ts` 单文件 503 行，同时违反清单的两条标准：
 * ① 文件 >500 行（上帝类门禁）；② 主类名 `RankVetoEvaluator` ≠ 文件名 `rankVeto`。
 * 按「职责缝」拆为三块后，本文件**只做聚合再导出**，
 * 使既有调用点（`tests/unit/rankVeto.test.ts`、`evals/rank-veto-retro.mjs`）**零改动**：
 *
 * | 文件 | 职责 |
 * | ---- | ---- |
 * | {@link ./rankVetoOverlap.ts} | Top-K 集合重合度量（主判据的量具） |
 * | {@link ./rankVetoSpectrum.ts} | 图结构性诊断（已被回溯验证证伪，仅报告） |
 * | {@link ./rankVetoEvaluator.ts} | 阈值、契约、判据编排（`RankVetoEvaluator`） |
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
