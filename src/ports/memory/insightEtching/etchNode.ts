/** 刻蚀后的分支节点（递归树）。 */
export interface EtchNode {
  /** 节点 ID。 */
  readonly id: string;
  /** 节点标签。 */
  readonly label: string;
  /** 子节点。 */
  readonly children: readonly EtchNode[];
}
