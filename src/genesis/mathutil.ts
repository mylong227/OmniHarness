/**
 * 向量数学工具（零依赖）。
 * 供 Modality 对齐、熵计算等使用；全部为确定性纯函数，便于推演与测试。
 */

/**
 * Mathutil —— 由本文件原顶层函数归并而来（每个方法对应一个原函数，语义与签名逐字保留）。
 */
export class Mathutil {
  /** 点积（带 noUncheckedIndexedAccess 安全守卫）。 */
  public static dot(a: ReadonlyArray<number>, b: ReadonlyArray<number>): number {
    const n = Math.min(a.length, b.length);
    let s = 0;
    for (let i = 0; i < n; i++) {
      s += (a[i] ?? 0) * (b[i] ?? 0);
    }
    return s;
  }

  /** L2 范数。 */
  public static norm(a: ReadonlyArray<number>): number {
    return Math.sqrt(Mathutil.dot(a, a)) || 0;
  }

  /** 余弦相似度 ∈ [-1, 1]；任一向量为零向量时定义返回 0（退化情形）。 */
  public static cosine(a: ReadonlyArray<number>, b: ReadonlyArray<number>): number {
    const na = Mathutil.norm(a);
    const nb = Mathutil.norm(b);
    if (na === 0 || nb === 0) return 0;
    return Mathutil.dot(a, b) / (na * nb);
  }

  /** 香农熵（以 2 为底），输入为概率分布。 */
  public static shannon(probabilities: ReadonlyArray<number>): number {
    let h = 0;
    for (const p of probabilities) {
      if (p > 0) h -= p * Math.log2(p);
    }
    return h;
  }
}
