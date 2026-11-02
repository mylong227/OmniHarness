/** 列表项（不回传完整定义，减小负载）。 */
export interface GraphSummary {
  /** 图的唯一 ID（= 文件名去扩展）。 */
  readonly id: string;
  /** 可读名（缺省与 id 相同）。 */
  readonly name: string;
  /** 步骤数。 */
  readonly stepCount: number;
}
