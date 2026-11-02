/** 一条刻蚀分支（可递归嵌套，构成分形决策树）。 */
export interface EtchBranch {
  /** 分支标签（决策节点摘要）。 */
  readonly label: string;
  /** 子分支（更深一层决策）。 */
  readonly subBranches?: readonly EtchBranch[];
}
