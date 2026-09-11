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
 * ## 设计约束（与全库一致）
 *  - 纯算法、无 IO、无进程状态：输入图与列表，输出只读报告，便于单测与跨场景复用。
 *  - fail-closed：调用方应把 `veto` 当作「跳过该排序路」，绝不因此让主流程崩溃。
 *
 * @maturity L2 — 主判据（查询敏感度）经真实语料回溯验证并机械解释已知负结果；
 *   但失败样本 n=1、对照 n=1，样本量不足以支撑 L3，见 `@maturityEvidence`
 * @maturityEvidence tests/unit/rankVeto.test.ts
 */

/** 有向带权邻接表（与 `codeGraph.CodeGraph` 同构，此处重复声明以避免与度量无关的耦合）。 */
interface VetoGraph {
  /** 节点数。 */
  readonly n: number;
  /** adj[i] = [[邻居 j, 权重], ...]。 */
  readonly adj: ReadonlyArray<ReadonlyArray<readonly [number, number]>>;
}

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

/** PageRank 阻尼系数（沿用 `codeGraph.propagate` 的经典值，保证与生产口径一致）。 */
const DAMPING = 0.85;

/** PageRank 迭代轮数（取生产 `getGraphSignal` 的 24 轮，口径一致才可比）。 */
const RANK_ITERS = 24;

/** 谱隙幂迭代轮数。 */
const SPECTRAL_ITERS = 30;

/** 不敏感度比值的分母下限：基线极查询专属时避免比值爆炸。 */
const INSENSITIVITY_FLOOR = 0.02;

/**
 * 计算两个 Top-K 列表（集合语义）的 Jaccard 重合度。
 *
 * @param a 列表 A
 * @param b 列表 B
 * @returns Jaccard ∈ [0,1]；完全相同为 1，完全不同为 0，两者皆空为 1
 */
export function jaccardOverlap(a: readonly string[], b: readonly string[]): number {
  const sa = new Set(a);
  const sb = new Set(b);
  if (sa.size === 0 && sb.size === 0) return 1;
  let inter = 0;
  for (const x of sa) if (sb.has(x)) inter++;
  return inter / (sa.size + sb.size - inter);
}

/**
 * 计算「跨查询重合度」：一批查询各自的 Top-K 之间，两两 Jaccard 的平均值。
 *
 * 语义：该路由**对查询的敏感程度**的反面。接近 1 表示「不论问什么都给同一批结果」，
 * 即路由退化为一记常量偏置；接近 0 表示结果随查询显著变化。
 *
 * **不需要标注数据**——只需一批探针查询文本，是本判据可零成本前置执行的关键。
 *
 * @param lists 每个探针查询一个 Top-K 列表
 * @returns 平均两两重合度 ∈ [0,1]；列表数 < 2 时返回 `null`（无法定义）
 */
export function meanPairwiseJaccard(lists: readonly (readonly string[])[]): number | null {
  if (lists.length < 2) return null;
  let sum = 0;
  let n = 0;
  for (let i = 0; i < lists.length; i++) {
    for (let j = i + 1; j < lists.length; j++) {
      sum += jaccardOverlap(lists[i]!, lists[j]!);
      n++;
    }
  }
  return n > 0 ? sum / n : null;
}

/**
 * 计算对称归一化邻接 `S = D^{-1/2} · (A + A^T)/2 · D^{-1/2}` 的对称度向量。
 *
 * @param g 有向带权图
 * @returns 长度 N 的对称度数组，d[i] = (出权和 + 入权和) / 2
 */
function symmetricDegree(g: VetoGraph): Float64Array {
  const d = new Float64Array(g.n);
  for (let i = 0; i < g.n; i++) {
    const es = g.adj[i]!;
    let out = 0;
    for (const [, w] of es) out += w;
    d[i] = (d[i] ?? 0) + out / 2;
    for (const [j, w] of es) d[j] = (d[j] ?? 0) + w / 2;
  }
  return d;
}

/**
 * 对对称归一化邻接做一次稀疏矩阵-向量乘。
 *
 * @param g 有向带权图
 * @param d 对称度向量
 * @param v 输入向量
 * @returns 乘积向量（新数组，不修改入参）
 */
function applyNormalizedAdjacency(g: VetoGraph, d: Float64Array, v: Float64Array): Float64Array {
  const out = new Float64Array(g.n);
  for (let i = 0; i < g.n; i++) {
    const di = d[i]!;
    if (di <= 0) continue;
    const scale = 1 / Math.sqrt(di);
    for (const [j, w] of g.adj[i]!) {
      const dj = d[j]!;
      if (dj <= 0) continue;
      const coef = (w / 2) * scale / Math.sqrt(dj);
      out[i] = (out[i] ?? 0) + coef * v[j]!;
      out[j] = (out[j] ?? 0) + coef * v[i]!;
    }
  }
  return out;
}

/**
 * 用带消去的幂迭代估计第二大特征值 λ2，返回谱隙 `1 − λ2`。
 *
 * @param g 有向带权图
 * @param d 对称度向量
 * @returns 谱隙 ∈ [0,1]；**越大表示混合越快**
 */
function estimateSpectralGap(g: VetoGraph, d: Float64Array): number {
  if (g.n < 3) return 1;
  const phi = new Float64Array(g.n);
  let phiNorm = 0;
  for (let i = 0; i < g.n; i++) {
    const v = Math.sqrt(Math.max(0, d[i]!));
    phi[i] = v;
    phiNorm += v * v;
  }
  if (phiNorm <= 0) return 1;
  phiNorm = Math.sqrt(phiNorm);
  for (let i = 0; i < g.n; i++) phi[i] = phi[i]! / phiNorm;

  // 确定性伪随机初值（避免测试因 Math.random 而不稳定）。
  let v: Float64Array = new Float64Array(g.n);
  for (let i = 0; i < g.n; i++) v[i] = Math.sin(i * 12.9898) * 0.5 + Math.cos(i * 78.233) * 0.5;
  let dot = 0;
  for (let i = 0; i < g.n; i++) dot += v[i]! * phi[i]!;
  for (let i = 0; i < g.n; i++) v[i] = v[i]! - dot * phi[i]!;

  let lambda2 = 0;
  for (let it = 0; it < SPECTRAL_ITERS; it++) {
    let norm = 0;
    for (let i = 0; i < g.n; i++) norm += v[i]! * v[i]!;
    norm = Math.sqrt(norm);
    if (norm <= 1e-12) return 0;
    for (let i = 0; i < g.n; i++) v[i] = v[i]! / norm;

    const next = applyNormalizedAdjacency(g, d, v);
    dot = 0;
    for (let i = 0; i < g.n; i++) dot += next[i]! * phi[i]!;
    for (let i = 0; i < g.n; i++) next[i] = next[i]! - dot * phi[i]!;

    let nextNorm = 0;
    for (let i = 0; i < g.n; i++) nextNorm += next[i]! * next[i]!;
    lambda2 = Math.sqrt(nextNorm);
    v = next;
  }
  return Math.min(1, Math.max(0, 1 - lambda2));
}

/**
 * 计算均匀传送 PageRank 的稳态分布（与 `getGraphSignal` 的文件中心性同口径）。
 *
 * @param g 有向带权图
 * @returns 归一化稳态分布（和为 1）
 */
function stationaryRank(g: VetoGraph): Float64Array {
  const n = g.n;
  const outWeight = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (const [, w] of g.adj[i]!) s += w;
    outWeight[i] = s;
  }
  let pi: Float64Array = new Float64Array(n).fill(1 / n);
  const next = new Float64Array(n);
  for (let it = 0; it < RANK_ITERS; it++) {
    next.fill(0);
    let danglingMass = 0;
    for (let i = 0; i < n; i++) {
      const ow = outWeight[i]!;
      const mass = pi[i]!;
      if (ow <= 0) {
        danglingMass += mass;
        continue;
      }
      for (const [j, w] of g.adj[i]!) next[j] = (next[j] ?? 0) + (mass * w) / ow;
    }
    const teleport = (1 - DAMPING) / n;
    for (let i = 0; i < n; i++) {
      next[i] = DAMPING * next[i]! + teleport + (DAMPING * danglingMass) / n;
    }
    let sum = 0;
    for (let i = 0; i < n; i++) sum += next[i]!;
    if (sum > 0) for (let i = 0; i < n; i++) next[i] = next[i]! / sum;
    pi = next.slice();
  }
  return pi;
}

/**
 * 计算分布的 Gini 系数。
 *
 * @param xs 非负样本
 * @returns Gini ∈ [0,1]；0 = 完全均等，1 = 完全集中
 */
function gini(xs: readonly number[]): number {
  const n = xs.length;
  if (n === 0) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  let sum = 0;
  let weighted = 0;
  for (let i = 0; i < n; i++) {
    sum += sorted[i]!;
    weighted += sorted[i]! * (i + 1);
  }
  if (sum <= 0) return 0;
  return (2 * weighted) / (n * sum) - (n + 1) / n;
}

/**
 * 计算分布相对均匀分布的信息量指标。
 *
 * @param pi 归一化分布
 * @returns `{ kl, supportRatio }`：KL(π‖U)（nats）与 `exp(H(π))/N`
 */
function uniformityOf(pi: Float64Array): { readonly kl: number; readonly supportRatio: number } {
  const n = pi.length;
  if (n === 0) return { kl: 0, supportRatio: 1 };
  let entropy = 0;
  let kl = 0;
  for (let i = 0; i < n; i++) {
    const p = pi[i]!;
    if (p > 0) {
      entropy -= p * Math.log(p);
      kl += p * Math.log(p * n);
    }
  }
  return { kl: Math.max(0, kl), supportRatio: Math.exp(entropy) / n };
}

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
    const cand = input.candidateProbeLists === undefined ? null : meanPairwiseJaccard(input.candidateProbeLists);
    const base = input.baselineProbeLists === undefined ? null : meanPairwiseJaccard(input.baselineProbeLists);
    const ratio = cand !== null && base !== null ? cand / Math.max(base, INSENSITIVITY_FLOOR) : null;
    const overlap =
      input.baselineFiles !== undefined && input.candidateFiles !== undefined
        ? jaccardOverlap(input.baselineFiles, input.candidateFiles)
        : null;

    if (input.graph === undefined) {
      return {
        queryInsensitivity: cand,
        baselineQueryInsensitivity: base,
        insensitivityRatio: ratio,
        overlapJaccard: overlap,
        nodeCount: null,
        edgeCount: null,
        avgDegree: null,
        degreeGini: null,
        spectralGap: null,
        uniformKl: null,
        effectiveSupportRatio: null,
      };
    }

    const g = input.graph;
    const d = symmetricDegree(g);
    const pi = stationaryRank(g);
    const { kl, supportRatio } = uniformityOf(pi);
    let edgeCount = 0;
    for (let i = 0; i < g.n; i++) edgeCount += g.adj[i]!.length;
    const degs: number[] = [];
    for (let i = 0; i < g.n; i++) degs.push(d[i]!);

    return {
      queryInsensitivity: cand,
      baselineQueryInsensitivity: base,
      insensitivityRatio: ratio,
      overlapJaccard: overlap,
      nodeCount: g.n,
      edgeCount,
      avgDegree: g.n > 0 ? edgeCount / g.n : 0,
      degreeGini: gini(degs),
      spectralGap: estimateSpectralGap(g, d),
      uniformKl: kl,
      effectiveSupportRatio: supportRatio,
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
        m.baselineQueryInsensitivity === null ? '（未提供基线对照）' : `（基线 ${m.baselineQueryInsensitivity.toFixed(3)}）`;
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
      notes.push(`[诊断·未通过回溯验证] 度分布 Gini ${m.degreeGini.toFixed(3)} 过低（近规则图），已知负样本实测 0.482`);
    }
    if (m.queryInsensitivity === null && m.overlapJaccard === null) {
      notes.push('[诊断] 未提供探针列表与基线，两项否决判据均跳过；结论仅含结构性诊断，不构成建议');
    }
    return notes;
  }
}
