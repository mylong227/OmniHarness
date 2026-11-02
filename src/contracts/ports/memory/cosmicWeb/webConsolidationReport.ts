/** 宇宙网一次 RG 粗粒化坍缩的报告。 */
export interface WebConsolidationReport {
  /** 坍缩后节点数（受 Bekenstein 容量界约束）。 */
  readonly nodes: number;
  /** 本轮坍缩掉的节点数（合并进更大簇）。 */
  readonly collapsed: number;
  /** 纤维数（节点间共振边，宇宙网骨架）。 */
  readonly fibers: number;
}
