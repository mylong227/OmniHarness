import type { AnnealStepReport } from '../memory/memoryAnnealing.js';
import type { WebConsolidationReport } from '../memory/cosmicWeb.js';
import type { QECReport } from '../intelligence/qec.js';
import type { ImmuneSelfReport } from '../intelligence/immune.js';
import type { BeliefUpdateReport } from '../intelligence/metacognition.js';
import type { CrisprEditReport } from '../runtime/skillEdit.js';
import type { CrystallizationReport } from '../intelligence/capability.js';
import type { SymmetryBreakReport } from '../intelligence/symmetryBreaking.js';
import type { ConfinementVerdict } from '../runtime/confinement.js';

/** 燧内核一轮调谐/冲刷/退火/宇宙网/QEC/免疫/信念的报告。 */
export interface SparkCycleReport {
  /** 是否真跑了（无活跃燧能力时为 false）。 */
  readonly ran: boolean;
  /** 燧-3 调谐结果（启用时）。 */
  readonly resonance?: { readonly facts: number; readonly clusters: number } | undefined;
  /** 燧-4 冲刷结果（启用时）。 */
  readonly vortex?: { readonly activeRings: number } | undefined;
  /** (D) 热方程记忆退火结果（启用时）。 */
  readonly anneal?: AnnealStepReport | undefined;
  /** (E) 宇宙网记忆 RG 坍缩结果（启用时）。 */
  readonly web?: WebConsolidationReport | undefined;
  /** (E) QEC 记忆全量校验+纠正结果（启用时）。 */
  readonly qec?: QECReport | undefined;
  /** (E) 免疫监控自检结果（启用时）。 */
  readonly immune?: ImmuneSelfReport | undefined;
  /** (P2) 信念支柱更新结果（启用时）：自然梯度 / 粒子滤波两类可审计 KL 分解。 */
  readonly belief?:
    | {
        readonly naturalGradient?: BeliefUpdateReport | undefined;
        readonly particleFilter?: BeliefUpdateReport | undefined;
      }
    | undefined;
  /** (P2, I-P2-4) CRISPR 精确编辑批量结果（启用时，队列非空才有产出）。 */
  readonly crispr?: readonly CrisprEditReport[] | undefined;
  /** (P2, I-P2-5) 相变固化结果（启用时）：经验密度越阈组合冻结为原生能力。 */
  readonly crystallizer?: CrystallizationReport | undefined;
  /** (P3, I-P3-1) 刻蚀记忆结果（启用时）：已刻蚀 trace 数 + 可选低阻导通路径。 */
  readonly etching?:
    { readonly traces: number; readonly conducted?: readonly string[] | undefined } | undefined;
  /** (P3, I-P3-2) 元素组合基元结果（启用时）：周期表规模 + 可选组合探针产物。 */
  readonly elementComposer?:
    { readonly elements: number; readonly compound?: string | null } | undefined;
  /** (P3, I-P3-3) 对称破缺快照（启用时）：序参量 ρ + 对称态 + 是否相变。 */
  readonly symmetry?: SymmetryBreakReport | undefined;
  /** (P3, I-P3-4) 禁闭色荷裁决（启用时）：暴露探针裁决。 */
  readonly confinement?: ConfinementVerdict | undefined;
}
