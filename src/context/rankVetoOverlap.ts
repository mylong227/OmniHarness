/**
 * 排序否决器的**重合度度量**：Top-K 列表之间的集合相似度。
 *
 * 这是否决器主判据（查询敏感度）的量具，单独成文件的原因：
 * 它**与图结构无关**，只吃字符串列表，可被任何排序路复用（含非图路由）。
 *
 * ## 语义
 *
 * - {@link jaccardOverlap}：两个 Top-K 集合的 Jaccard；
 * - {@link meanPairwiseJaccard}：一批查询各自 Top-K 的**平均两两** Jaccard。
 *
 * `meanPairwiseJaccard` 接近 1 = 不论问什么都给同一批结果（常量偏置）；
 * 接近 0 = 结果随查询显著变化。它**不需要标注数据**——只要一批探针查询文本，
 * 这正是「排序实验之前先否决」可以零成本执行的原因。
 *
 * ## 设计约束
 *  - 纯函数、零 IO、无状态、确定性。
 *  - 空列表语义显式：两者皆空视为完全重合（返回 1），避免除零与「假不敏感」。
 *
 * @see ./rankVetoEvaluator.ts — 判据与阈值的编排方
 */

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
