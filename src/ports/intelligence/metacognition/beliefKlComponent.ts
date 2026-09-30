/** KL 分解的逐维分量。 */
export interface BeliefKlComponent {
  /** 维度下标。 */
  readonly dim: number;
  /** 该维"均值漂移"引起的 KL 分量。 */
  readonly meanShift: number;
  /** 该维"方差变化"引起的 KL 分量。 */
  readonly variance: number;
  /** 该维 KL 总量（= meanShift + variance）。 */
  readonly total: number;
}
