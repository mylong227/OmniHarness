/**
 * 排序前置否决器（RankVetoEvaluator）——在「花时间跑排序实验之前」先判定该排序路是否可能有信息。
 *
 * ## 本模块的判据是**被真实数据改过一次**的，改动经过必须留档
 *
 * 第一版判据是「结构性退化」：谱隙大 / 稳态近均匀 / 度分布近规则 ⇒ 否决。
 * 依据的既有解释是「429k 稠密边导致 PageRank **收敛至近均匀**」（见 `codeGraph.ts` 与
 * `contextEngine.query()` 的历史注释）。
 *
 * **回溯验证（`evals/rank-veto-retro.mjs`）证伪了它**：真实稠密图实测
 * 谱隙 **0.2795**、稳态 KL **0.5219**、有效支撑率 **0.5934**、度 Gini **0.482**——
 * 分布一点也不均匀，三条判据一条都没触发，而该路已知实测 **−6.1pp**。
 * 「收敛至近均匀」这个流传已久的解释**是错的**，已在 `codeGraph.ts` / `contextEngine.ts` 更正。
 *
 * 真机理来自同一次回溯的另一项测量（33 条真实查询，Top-14）：
 *
 * | 路由            | 跨查询平均重合度 | 结果        |
 * | --------------- | ---------------- | ----------- |
 * | BM25（已知有效） | **0.058**        | 高度查询专属 |
 * | 图路由（已知负） | **0.942**        | 几乎常量     |
 *
 * 图排序并非「退化」，而是**对查询不敏感**：枢纽文件在 **33/33** 条查询里全部出现。
 * 它是一记**常量偏置**——无论问什么都塞进同一批枢纽文件，白占 Top-K 预算、挤掉真正相关的文件。
 * 这才是 −6.1pp / −2.6pp 的机械成因。
 *
 * 因此本模块以 **查询敏感度**为主判据（已回溯验证），结构性度量**降级为诊断项**
 * （仍计算并报告，但不作否决依据，诊断文案里标明「未通过回溯验证」）。
 *
 * ## 查询敏感度判据为什么便宜
 *
 * 它**不需要标注数据**：只要一批探针查询（无需 ground truth），量各查询 Top-K 之间的两两重合度。
 * 「这条路由是不是对所有问题都给同一个答案」——这可以在毫秒级判定，且**不会说谎**。
 *
 * ## ⚠️ 已知局限：**放行 ≠ 有效**（2026-09-12 由一次负结果确立）
 *
 * 本判据是**必要条件，不是充分条件**。它只能排除「常量偏置」这类**结构性**错误，
 * 无法保证路由给出的是**正确**的东西——「每次给不同的文件」与「每次给对的文件」是两回事。
 *
 * 实测反例（`evals/layered-recall-ab.mjs`，32 条查询，fileK=14）：
 * 层化图路由的查询敏感度 **0.038**（比 BM25 的 0.058 还低，即"高度查询专属"），
 * 与 BM25 簇重合度 0.247（远低于 0.7 复读线）⇒ **否决器放行**；
 * 但召回实测 **28.9% vs BM25 38.0%，Δ −9.1pp**。
 * 它对每条查询确实给出了不同的文件——只是给错了。
 *
 * 因此**两关流程不可省**：
 *   第 1 关（本模块）否决器排除结构性错误——便宜、免标注、毫秒级；
 *   第 2 关（AB 评测）同 corpus 开关隔离的召回对照——贵，但只有它能回答"有没有用"。
 * **通过第 1 关不构成任何有效性承诺。**
 *
 * ## 文件拆分（2026-09-12，为符合「一文件一类 / <500 行」清单标准）
 *
 * - {@link ./rankVetoOverlap.ts}：Top-K 集合重合度量（主判据的量具，与图无关）；
 * - {@link ./rankVetoSpectrum.ts}：图结构性诊断（已被证伪，仅报告）；
 * - 本文件：阈值、输入/输出契约、判据编排；
 * - {@link ./rankVeto.ts}：兼容门面，聚合再导出，调用点零改动。
 *
 * @maturity L2 — 主判据（查询敏感度）经真实语料回溯验证并机械解释已知负结果；
 *   但失败样本 n=1、对照 n=1，样本量不足以支撑 L3，见 `@maturityEvidence`
 * @maturityEvidence tests/unit/rankVeto.test.ts
 */

import { jaccardOverlap, meanPairwiseJaccard } from './rankVetoOverlap.js';
import { structuralDiagnostics } from './rankVetoSpectrum.js';
import type { StructuralDiagnostics, VetoGraph } from './rankVetoSpectrum.js';

/** 否决阈值集合。 */
export interface VetoThresholds {
  /**
   * 候选路由的跨查询重合度 ≥ 此值判定「对查询不敏感」。默认 0.5。
   *
   * 标定依据（诚实：样本量极小）：已知负样本（图路由）实测 **0.942**，
   * 已知有效对照（BM25）实测 **0.058**。0.5 取两者近似中点，
   * 且具自然语义——「超过一半的槽位在所有查询间重复」。
   * **失败样本 n=1、对照 n=1**，新路由接入后应重跑 `evals/rank-veto-retro.mjs` 复核。
   */
  readonly maxQueryInsensitivity: number;
  /**
   * 与基线 Top-K 的 Jaccard 重合度 ≥ 此值判定「与基线冗余」。默认 0.70。
   *
   * 这是 T2 **预先承诺的失败判据**：新路若只是基线的复读，就没有存在价值。
   * 注：回溯验证中该判据**未触发**（图路由与 BM25 重合度仅 0.074，是正交而非复读），
   * 因此它针对的是另一种失败模式，保留待验。
   */
  readonly maxOverlapJaccard: number;
}

/** 默认阈值。 */
export const DEFAULT_VETO_THRESHOLDS: VetoThresholds = {
  maxQueryInsensitivity: 0.5,
  maxOverlapJaccard: 0.7,
};

/** 度量结果（否决判据 + 诊断项，全部为纯量，便于写入报告与门禁断言）。 */
export interface VetoMetrics {
  /** 查询不敏感度：候选路由在各查询 Top-K 之间的平均两两 Jaccard；1 = 对所有查询返回同一批。 */
  readonly queryInsensitivity: number | null;
  /** 同一批探针查询下基线路由的查询不敏感度（对照基准）。 */
  readonly baselineQueryInsensitivity: number | null;
  /** 不敏感度比值 `candidate / max(baseline, 0.02)`；远大于 1 表示候选比基线更「常量」。 */
  readonly insensitivityRatio: number | null;
  /** 与基线 Top-K 的 Jaccard 重合度；`null` 表示未提供基线/候选，判据跳过。 */
  readonly overlapJaccard: number | null;
  /** 以下为**结构性诊断项**（不参与否决，见类注释：未通过回溯验证）。 */
  readonly nodeCount: number | null;
  readonly edgeCount: number | null;
  readonly avgDegree: number | null;
  /** 度分布 Gini [0,1]；0 = 完全规则。 */
  readonly degreeGini: number | null;
  /** 对称归一化邻接谱隙 `1 − λ2`；**越大表示混合越快**。 */
  readonly spectralGap: number | null;
  /** PageRank 稳态与均匀分布的 KL（nats）；0 = 完全均匀。 */
  readonly uniformKl: number | null;
  /** 有效支撑率 `exp(H(π))/N` ∈ (0,1]；1 = 完全均匀。 */
  readonly effectiveSupportRatio: number | null;
}

/** 否决报告。 */
export interface RankVetoReport {
  /** `veto` = 建议跳过该排序路；`proceed` = 允许跑实验。 */
  readonly verdict: 'veto' | 'proceed';
  /** 全部度量。 */
  readonly metrics: VetoMetrics;
  /** 命中的否决理由（含实测数值，便于复核而非黑箱）。 */
  readonly reasons: readonly string[];
  /** 诊断性提示：**不参与否决**，仅提示可能的风险或已证伪的假设。 */
  readonly notes: readonly string[];
}

/** 评估输入：`graph` 给结构性诊断，`*ProbeLists` 给主判据。 */
export interface RankVetoInput {
  /** 待评估的图（可选；提供则计算结构性诊断项）。 */
  readonly graph?: VetoGraph;
  /** 基线排序的 Top-K 文件（单次查询口径，用于重合度判据）。 */
  readonly baselineFiles?: readonly string[];
  /** 候选排序路的 Top-K 文件（与 `baselineFiles` 成对提供）。 */
  readonly candidateFiles?: readonly string[];
  /** 候选路由在**一批探针查询**下的 Top-K 列表（主判据所需）。 */
  readonly candidateProbeLists?: readonly (readonly string[])[];
  /** 基线路由在同一批探针查询下的 Top-K 列表（对照基准）。 */
  readonly baselineProbeLists?: readonly (readonly string[])[];
}

/** 不敏感度比值的分母下限：基线极查询专属时避免比值爆炸。 */
const INSENSITIVITY_FLOOR = 0.02;

/** 无图时的空诊断（除节点/边/度外全为 `null`，避免调用方区分「未提供」与「实测 0」）。 */
const EMPTY_METRICS_BASE: Omit<
  VetoMetrics,
  'queryInsensitivity' | 'baselineQueryInsensitivity' | 'insensitivityRatio' | 'overlapJaccard'
> = {
  nodeCount: null,
  edgeCount: null,
  avgDegree: null,
  degreeGini: null,
  spectralGap: null,
  uniformKl: null,
  effectiveSupportRatio: null,
};

/**
 * 把结构性诊断快照摊平进 {@link VetoMetrics}（未提供图时全部置 `null`）。
 *
 * @param d 诊断快照；`null` 表示调用方未提供图
 * @returns 摊平后的度量片段
 */

/**
 * 排序前置否决器：在跑排序实验之前，先判定这条排序路是否可能携带信息。
 *
 * 主判据为**查询敏感度**（已回溯验证）；结构性度量仅作诊断（未通过回溯验证，见模块注释）。
 */
export class RankVetoEvaluator {
  /** 阈值快照（构造即冻结）。 */
  private readonly thresholds: VetoThresholds;

  /**
   * @param thresholds 否决阈值；省略则用 {@link DEFAULT_VETO_THRESHOLDS}
   */
  public constructor(thresholds: VetoThresholds = DEFAULT_VETO_THRESHOLDS) {
    this.thresholds = thresholds;
  }

  /**
   * 评估一个候选排序路是否值得跑实验。
   *
   * @param input 探针列表（主判据）+ 可选图（结构性诊断）+ 可选单次基线/候选（重合度判据）
   * @returns 否决报告（含全部度量、否决理由与诊断提示）
   */
  public evaluate(input: RankVetoInput): RankVetoReport {
    const metrics = this.measure(input);
    const reasons = this.decide(metrics);
    const notes = this.diagnose(metrics);
    return { verdict: reasons.length > 0 ? 'veto' : 'proceed', metrics, reasons, notes };
  }

  /**
   * 采集全部度量。
   *
   * @param input 评估输入
   * @returns 度量快照
   */
  private measure(input: RankVetoInput): VetoMetrics {
    const cand =
      input.candidateProbeLists === undefined
        ? null
        : meanPairwiseJaccard(input.candidateProbeLists);
    const base =
      input.baselineProbeLists === undefined ? null : meanPairwiseJaccard(input.baselineProbeLists);
    const ratio =
      cand !== null && base !== null ? cand / Math.max(base, INSENSITIVITY_FLOOR) : null;
    const overlap =
      input.baselineFiles !== undefined && input.candidateFiles !== undefined
        ? jaccardOverlap(input.baselineFiles, input.candidateFiles)
        : null;
    const structural = input.graph === undefined ? null : structuralDiagnostics(input.graph);

    return {
      queryInsensitivity: cand,
      baselineQueryInsensitivity: base,
      insensitivityRatio: ratio,
      overlapJaccard: overlap,
      ...RankVetoEvaluator.flattenDiagnostics(structural),
    };
  }

  /**
   * 逐条比对度量与阈值，产出否决理由（**仅含已通过回溯验证或逻辑自明的判据**）。
   *
   * @param m 度量快照
   * @returns 命中理由；为空表示放行
   */
  private decide(m: VetoMetrics): readonly string[] {
    const t = this.thresholds;
    const reasons: string[] = [];
    if (m.queryInsensitivity !== null && m.queryInsensitivity >= t.maxQueryInsensitivity) {
      const ref =
        m.baselineQueryInsensitivity === null
          ? '（未提供基线对照）'
          : `（基线 ${m.baselineQueryInsensitivity.toFixed(3)}）`;
      reasons.push(
        `查询不敏感度 ${m.queryInsensitivity.toFixed(3)} ≥ ${t.maxQueryInsensitivity}${ref}：该路由对不同查询返回近乎同一批结果，是一记常量偏置，只会挤占 Top-K 预算`,
      );
    }
    if (m.overlapJaccard !== null && m.overlapJaccard >= t.maxOverlapJaccard) {
      reasons.push(
        `与基线 Top-K 重合度 ${m.overlapJaccard.toFixed(3)} ≥ ${t.maxOverlapJaccard}：新路只是基线的复读，无增量信息`,
      );
    }
    return reasons;
  }

  /**
   * 产出诊断提示（**不参与否决**）。结构性判据在此报告，并显式标注其验证状态，
   * 以免后来者误以为它们已被证实有效。
   *
   * @param m 度量快照
   * @returns 诊断提示数组
   */
  private diagnose(m: VetoMetrics): readonly string[] {
    const notes: string[] = [];
    if (m.spectralGap !== null && m.spectralGap >= 0.5) {
      notes.push(
        `[诊断·未通过回溯验证] 谱隙 ${m.spectralGap.toFixed(3)} 偏大（混合快），但已知负样本实测仅 0.2795，该判据未触发，故不作否决依据`,
      );
    }
    if (m.effectiveSupportRatio !== null && m.effectiveSupportRatio >= 0.8) {
      notes.push(
        `[诊断·未通过回溯验证] 有效支撑率 ${m.effectiveSupportRatio.toFixed(3)} 偏高（稳态趋均匀），已知负样本实测 0.5934，该判据未触发`,
      );
    }
    if (m.degreeGini !== null && m.degreeGini <= 0.1) {
      notes.push(
        `[诊断·未通过回溯验证] 度分布 Gini ${m.degreeGini.toFixed(3)} 过低（近规则图），已知负样本实测 0.482`,
      );
    }
    if (m.queryInsensitivity === null && m.overlapJaccard === null) {
      notes.push('[诊断] 未提供探针列表与基线，两项否决判据均跳过；结论仅含结构性诊断，不构成建议');
    }
    return notes;
  }
  /**
   * flattenDiagnostics — module-level helper moved into RankVetoEvaluator.
   * @param {StructuralDiagnostics | null} d - d
   * @returns {Omit<
  VetoMetrics,
  'queryInsensitivity' | 'baselineQueryInsensitivity' | 'insensitivityRatio' | 'overlapJaccard'
>} - result
   */
  private static flattenDiagnostics(
    d: StructuralDiagnostics | null,
  ): Omit<
    VetoMetrics,
    'queryInsensitivity' | 'baselineQueryInsensitivity' | 'insensitivityRatio' | 'overlapJaccard'
  > {
    if (d === null) return EMPTY_METRICS_BASE;
    return {
      nodeCount: d.nodeCount,
      edgeCount: d.edgeCount,
      avgDegree: d.avgDegree,
      degreeGini: d.degreeGini,
      spectralGap: d.spectralGap,
      uniformKl: d.uniformKl,
      effectiveSupportRatio: d.effectiveSupportRatio,
    };
  }
}
