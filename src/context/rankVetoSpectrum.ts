/**
 * 排序否决器的**结构性诊断**（图侧度量）。
 *
 * ## 为什么这些度量**不再参与否决**
 *
 * 本模块第一版是判据，回溯验证（`evals/rank-veto-retro.mjs`）把它**证伪**了：
 * 已知实测为负的稠密图（−6.1pp）实测谱隙 **0.2795**、稳态 KL **0.5219**、
 * 有效支撑率 **0.5934**、度 Gini **0.482**——分布一点也不均匀，一条判据都没触发。
 * 代码库中流传的「PageRank 收敛至近均匀」解释**是错的**（已在 `codeGraph.ts` /
 * `contextEngine.ts` 更正）。
 *
 * 因此本模块降级为**诊断项**：仍计算并报告，但不作否决依据；
 * 诊断文案由 {@link ./rankVetoEvaluator.ts} 统一标注「未通过回溯验证」，
 * 以免后来者误以为它们已被证实有效。保留它们的价值在于**可复核**：
 * 下一个图路由接入时，这些数字仍能说明「图长什么样」。
 *
 * ## 谱隙方向的更正（易错点）
 *
 * 谱隙 `1 − λ2` **越大 ⇒ 混合越快 ⇒ 越趋均匀**。稠密图的 λ2 反而**小**
 * （≈ O(1/√d)），所以「稠密 ⇒ 谱隙小 ⇒ 收敛慢」，与直觉相反。
 * 本文件注释按更正后的方向书写。
 *
 * ## 设计约束
 *  - 纯算法、零 IO、无状态；初值用**确定性伪随机**（`sin/cos` 混合），保证单测可复现。
 *  - 与生产口径对齐：PageRank 取 `codeGraph.propagate` 的阻尼 0.85 / 24 轮。
 *
 * @see ./rankVetoEvaluator.ts — 判据编排方（主判据是查询敏感度，不是这里的结构量）
 */

/** 有向带权邻接表（与 `codeGraph.CodeGraph` 同构，此处重复声明以避免与度量无关的耦合）。 */
export interface VetoGraph {
  /** 节点数。 */
  readonly n: number;
  /** adj[i] = [[邻居 j, 权重], ...]。 */
  readonly adj: ReadonlyArray<ReadonlyArray<readonly [number, number]>>;
}

/** 结构性诊断结果（**不参与否决**，仅用于复核与报告）。 */
export interface StructuralDiagnostics {
  /** 节点数。 */
  readonly nodeCount: number;
  /** 有向边总数。 */
  readonly edgeCount: number;
  /** 平均（对称）度。 */
  readonly avgDegree: number;
  /** 度分布 Gini [0,1]；0 = 完全规则。 */
  readonly degreeGini: number;
  /** 对称归一化邻接谱隙 `1 − λ2`；**越大表示混合越快**。 */
  readonly spectralGap: number;
  /** PageRank 稳态与均匀分布的 KL（nats）；0 = 完全均匀。 */
  readonly uniformKl: number;
  /** 有效支撑率 `exp(H(π))/N` ∈ (0,1]；1 = 完全均匀。 */
  readonly effectiveSupportRatio: number;
}

/** PageRank 阻尼系数（沿用 `codeGraph.propagate` 的经典值，保证与生产口径一致）。 */
const DAMPING = 0.85;

/** PageRank 迭代轮数（取生产 `getGraphSignal` 的 24 轮，口径一致才可比）。 */
const RANK_ITERS = 24;

/** 谱隙幂迭代轮数。 */
const SPECTRAL_ITERS = 30;

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
      const coef = ((w / 2) * scale) / Math.sqrt(dj);
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
 * 一次性采集图的全部结构性诊断项。
 *
 * **这些项不参与否决**（见模块头部：已被回溯验证证伪），仅供复核与报告。
 *
 * @param g 待诊断的图
 * @returns 结构性诊断快照
 */
export function structuralDiagnostics(g: VetoGraph): StructuralDiagnostics {
  const d = symmetricDegree(g);
  const pi = stationaryRank(g);
  const { kl, supportRatio } = uniformityOf(pi);
  let edgeCount = 0;
  for (let i = 0; i < g.n; i++) edgeCount += g.adj[i]!.length;
  const degs: number[] = [];
  for (let i = 0; i < g.n; i++) degs.push(d[i]!);
  return {
    nodeCount: g.n,
    edgeCount,
    avgDegree: g.n > 0 ? edgeCount / g.n : 0,
    degreeGini: gini(degs),
    spectralGap: estimateSpectralGap(g, d),
    uniformKl: kl,
    effectiveSupportRatio: supportRatio,
  };
}
