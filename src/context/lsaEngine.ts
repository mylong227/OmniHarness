/**
 * 零依赖潜语义检索（LSA / Latent Semantic Analysis）。
 *
 * 为什么需要它：BM25、频域共振、跨文件引用图**全部只认字面共现**，对「词法错位」型
 * 查询（如 "sandbox policy evaluated" vs 含 `execPolicy` 的文件）集体失效——它们是
 * 概念关系而非字面关系。LSA 用 SVD 把词与符号投影到潜空间，让在语料中**统计共现**的
 * 「policy / evaluate」与 `execPolicy` 自然靠近，从而桥接词法错位。
 *
 * 实现：在「符号 × 词项」TF-IDF 矩阵上做截断 SVD（目标秩 k）。
 *   - 随机 SVD（Halko 等 Algorithm 5.1）求近似基 Q；
 *   - 对小型 k×k 矩阵做 Jacobi 特征值分解得奇异值/向量（数值稳定、零依赖）；
 *   - 符号潜向量 = V（n×k），查询投影 = Σ⁻¹·Uᵀ·q。
 *
 * 全程标准库，无外部依赖，确定性（RNG 可种子化）。这是静态检索里唯一直接针对
 * 「词法错位」的技术，也是破 61% 天花板的最后一张零依赖牌。
 *
 * OOP 收口：原模块级纯函数归拢为 `LsaEngine` 类方法；保留 `trainLsa` / `lsaQuery`
 * 同名门面（委托单例）以兼容既有调用点（src/context/contextEngine.ts）。
 *
 * @maturity L1 — 截断 SVD 存在；实测叠加有害（Eckart–Young 是重构最优≠排序保序）
 * @maturityEvidence tests/unit/lsaRecall.test.ts
 */

import { tokenize } from '../search/bm25Index.js';
import type { IndexedCorpus } from './contextEngine.js';

export interface LsaModel {
  readonly k: number;
  readonly n: number;
  readonly termIndex: ReadonlyMap<string, number>;
  /** 符号潜向量，row-major：symLatent[(j * k) + c]，j=符号序号，c=潜维度。 */
  readonly symLatent: Float64Array;
  /** 查询投影基 U（m×k，m=词项数），row-major：U[(t * k) + c]。 */
  readonly U: Float64Array;
  /** 奇异值 Σ（k）。 */
  readonly sigma: Float64Array;
}

/**
 * 零依赖 LSA 检索引擎。
 * 把原 `trainLsa`/`lsaQuery` 及其私有数学辅助函数归拢为类方法；
 * 无模块级可变状态——RNG 种子、词表等全部随 `train` 调用在方法栈内流转。
 */
export class LsaEngine {
  /** 可种子化 RNG（mulberry32），保证 SVD 随机基可复现。 */
  private rng(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /** 构建 TF-IDF 词项×符号矩阵（稀疏 CSR 风格），并返回词表与文档频率。 */
  private buildTfIdf(corpus: IndexedCorpus): {
    vocab: string[];
    termIndex: Map<string, number>;
    cols: number[][];
    vals: number[][];
    df: Float64Array;
    n: number;
  } {
    const n = corpus.symbols.length;
    const termIndex = new Map<string, number>();
    const vocab: string[] = [];
    const dfCount = new Map<string, number>();

    // 每个符号的「文档」= 其所属文件的全部文本（符号与文件共现信号最丰富）。
    const fileTextOfSymbol: string[] = new Array(n);
    for (let i = 0; i < n; i++) {
      const rel = corpus.symbols[i]!.file;
      const text = corpus.fileText.get(rel) ?? '';
      fileTextOfSymbol[i] = text;
    }

    // 第一遍：建词表 + 文档频率。
    const docTokens: string[][] = new Array(n);
    for (let j = 0; j < n; j++) {
      const toks = tokenize(fileTextOfSymbol[j] ?? '');
      docTokens[j] = toks;
      const uniq = new Set(toks);
      for (const t of uniq) {
        dfCount.set(t, (dfCount.get(t) ?? 0) + 1);
        if (!termIndex.has(t)) {
          termIndex.set(t, vocab.length);
          vocab.push(t);
        }
      }
    }

    const m = vocab.length;
    const df = new Float64Array(m);
    for (let t = 0; t < m; t++) df[t] = dfCount.get(vocab[t]!) ?? 1;

    // 第二遍：TF-IDF 值（对数 tf × idf）。
    const cols: number[][] = [];
    const vals: number[][] = [];
    const N = n;
    for (let j = 0; j < n; j++) {
      const toks = docTokens[j] ?? [];
      const tf = new Map<string, number>();
      for (const t of toks) tf.set(t, (tf.get(t) ?? 0) + 1);
      const col: number[] = [];
      const val: number[] = [];
      for (const [t, c] of tf) {
        const ti = termIndex.get(t)!;
        const idf = Math.log(1 + N / (df[ti]! + 1e-9));
        const tfidf = (1 + Math.log(c)) * idf;
        col.push(ti);
        val.push(tfidf);
      }
      cols.push(col);
      vals.push(val);
    }
    return { vocab, termIndex, cols, vals, df, n };
  }

  /** 稀疏矩阵 A（m×n）乘以稠密矩阵 X（n×r）— 这里用于 A Ω。 */
  private sparseMatMul(
    Acols: number[][],
    Avals: number[][],
    X: Float64Array,
    m: number,
    n: number,
    r: number,
  ): Float64Array {
    const Y = new Float64Array(m * r);
    for (let j = 0; j < n; j++) {
      const col = Acols[j] ?? [];
      const val = Avals[j] ?? [];
      for (let a = 0; a < col.length; a++) {
        const row = col[a]!;
        const v = val[a]!;
        for (let c = 0; c < r; c++) Y[row * r + c] = Y[row * r + c]! + v * X[j * r + c]!;
      }
    }
    return Y;
  }

  /** 对 m×r 矩阵做 Gram-Schmidt 正交化，返回 Q（m×r）。 */
  private orthonormalize(Y: Float64Array, m: number, r: number): Float64Array {
    const Q = new Float64Array(m * r);
    for (let c = 0; c < r; c++) {
      const col = new Float64Array(m);
      for (let i = 0; i < m; i++) col[i] = Y[i * r + c]!;
      for (let d = 0; d < c; d++) {
        let dot = 0;
        for (let i = 0; i < m; i++) dot += col[i]! * Q[i * r + d]!;
        for (let i = 0; i < m; i++) col[i] = col[i]! - dot * Q[i * r + d]!;
      }
      let norm = 0;
      for (let i = 0; i < m; i++) norm += col[i]! * col[i]!;
      norm = Math.sqrt(norm) || 1;
      for (let i = 0; i < m; i++) Q[i * r + c] = col[i]! / norm;
    }
    return Q;
  }

  /** 对 k×k 对称矩阵做 Jacobi 特征值分解，返回 {values(升序), vectors(列=特征向量)}。 */
  private jacobiEigen(A: Float64Array, k: number): { values: Float64Array; vectors: Float64Array } {
    const V = new Float64Array(k * k);
    for (let i = 0; i < k; i++) V[i * k + i] = 1;
    const a = A.slice();
    for (let sweep = 0; sweep < 50; sweep++) {
      let off = 0;
      for (let p = 0; p < k; p++)
        for (let q = p + 1; q < k; q++) off += a[p * k + q]! * a[p * k + q]!;
      if (off < 1e-12) break;
      for (let p = 0; p < k; p++) {
        for (let q = p + 1; q < k; q++) {
          const apq = a[p * k + q]!;
          if (Math.abs(apq) < 1e-15) continue;
          const app = a[p * k + p]!;
          const aqq = a[q * k + q]!;
          const phi = 0.5 * Math.atan2(2 * apq, aqq - app);
          const c = Math.cos(phi);
          const s = Math.sin(phi);
          for (let i = 0; i < k; i++) {
            const aip = a[i * k + p]!;
            const aiq = a[i * k + q]!;
            a[i * k + p] = c * aip - s * aiq;
            a[i * k + q] = s * aip + c * aiq;
          }
          for (let i = 0; i < k; i++) {
            const api = a[p * k + i]!;
            const aqi = a[q * k + i]!;
            a[p * k + i] = c * api - s * aqi;
            a[q * k + i] = s * api + c * aqi;
          }
          for (let i = 0; i < k; i++) {
            const vip = V[i * k + p]!;
            const viq = V[i * k + q]!;
            V[i * k + p] = c * vip - s * viq;
            V[i * k + q] = s * vip + c * viq;
          }
        }
      }
    }
    const values = new Float64Array(k);
    for (let i = 0; i < k; i++) values[i] = a[i * k + i]!;
    return { values, vectors: V };
  }

  /** 在已索引语料上训练 LSA 模型（截断秩 k）。 */
  public train(corpus: IndexedCorpus, k = 64, seed = 1234567): LsaModel {
    const { vocab, termIndex, cols, vals, n } = this.buildTfIdf(corpus);
    const m = vocab.length;
    const r = k;

    // 随机 SVD：Y = A Ω，Q = orth(Y)，再做一次幂迭代增强。
    const rand = this.rng(seed);
    const Omega = new Float64Array(n * r);
    for (let i = 0; i < Omega.length; i++) Omega[i] = rand() * 2 - 1;
    let Y = this.sparseMatMul(cols, vals, Omega, m, n, r);
    Y = this.sparseMatMul(cols, vals, Y, m, n, r); // 一次幂迭代
    const Q = this.orthonormalize(Y, m, r);

    // B = Qᵀ A（k×n）。
    const B = new Float64Array(r * n);
    for (let c = 0; c < r; c++) {
      for (let j = 0; j < n; j++) {
        const col = cols[j] ?? [];
        const val = vals[j] ?? [];
        let s = 0;
        for (let a = 0; a < col.length; a++) s += Q[col[a]! * r + c]! * val[a]!;
        B[c * n + j] = s;
      }
    }

    // C = B Bᵀ（k×k 对称），Jacobi 特征分解。
    const C = new Float64Array(r * r);
    for (let i = 0; i < r; i++)
      for (let jj = 0; jj < r; jj++) {
        let s = 0;
        for (let j = 0; j < n; j++) s += B[i * n + j]! * B[jj * n + j]!;
        C[i * r + jj] = s;
      }
    const { values, vectors: Vc } = this.jacobiEigen(C, r);

    // 奇异值 Σ = sqrt(λ)，U_B = 特征向量。
    const sigma = new Float64Array(r);
    for (let i = 0; i < r; i++) sigma[i] = Math.sqrt(Math.max(values[i]!, 0));

    // U = Q · U_B（m×k）。
    const U = new Float64Array(m * r);
    for (let i = 0; i < m; i++)
      for (let c = 0; c < r; c++) {
        let s = 0;
        for (let d = 0; d < r; d++) s += Q[i * r + d]! * Vc[d * r + c]!;
        U[i * r + c] = s;
      }

    // 符号潜向量 V_B（n×k）：V_B[j] = Bᵀ U_B[:,c] / Σ_c。
    const symLatent = new Float64Array(n * r);
    for (let j = 0; j < n; j++) {
      for (let c = 0; c < r; c++) {
        const s = sigma[c]! > 1e-9 ? B[c * n + j]! / sigma[c]! : 0;
        symLatent[j * r + c] = s;
      }
    }

    return { k: r, n, termIndex, symLatent, U, sigma };
  }

  /** 用 LSA 模型对查询做潜语义符号召回，返回 [符号id, 分数] 降序列表（Top limit）。 */
  public query(
    model: LsaModel,
    q: string,
    limit = 40,
  ): Array<{ id: number; score: number }> {
    const { k, n, termIndex, symLatent, U, sigma } = model;
    // 查询词项向量（TF-IDF，idf 近似取 1）。
    const qTf = new Map<string, number>();
    for (const t of tokenize(q)) qTf.set(t, (qTf.get(t) ?? 0) + 1);
    // q_proj = Σ⁻¹ Uᵀ q（k 维）。
    const qProj = new Float64Array(k);
    for (const [t, c] of qTf) {
      const ti = termIndex.get(t);
      if (ti === undefined) continue;
      for (let d = 0; d < k; d++) qProj[d] = qProj[d]! + U[ti * k + d]! * (1 + Math.log(c));
    }
    for (let d = 0; d < k; d++) qProj[d] = sigma[d]! > 1e-9 ? qProj[d]! / sigma[d]! : 0;

    const scores = new Float64Array(n);
    for (let j = 0; j < n; j++) {
      let s = 0;
      for (let d = 0; d < k; d++) s += qProj[d]! * symLatent[j * k + d]!;
      scores[j] = s;
    }
    const idx = Array.from({ length: n }, (_, i) => i);
    idx.sort((a, b) => scores[b]! - scores[a]!);
    return idx.slice(0, limit).map((id) => ({ id, score: scores[id]! }));
  }
}

// ---- 门面兼容：保留原函数名，委托单例，既有调用点无需改动 ----
const lsaEngine = new LsaEngine();

/** 在已索引语料上训练 LSA 模型（截断秩 k）。 */
export function trainLsa(corpus: IndexedCorpus, k = 64, seed = 1234567): LsaModel {
  return lsaEngine.train(corpus, k, seed);
}

/** 用 LSA 模型对查询做潜语义符号召回，返回 [符号id, 分数] 降序列表（Top limit）。 */
export function lsaQuery(
  model: LsaModel,
  q: string,
  limit = 40,
): Array<{ id: number; score: number }> {
  return lsaEngine.query(model, q, limit);
}
