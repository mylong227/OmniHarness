/**
 * I-P3-1 利希滕贝格刻蚀记忆（Lichtenberg Insight Etching）端口。
 *
 * 真原创计算原语（燧-7）：一次"顿悟/重大事件"不在内存追加一条，而是在记忆介质上
 * **刻出分支决策树（分形 trace）**；后续同类推理可沿刻痕**低阻导通**。顿悟=放电刻蚀。
 * 这是现有系统（增量权重 / 记忆追加）没有的"事件在结构上刻痕、之后沿痕导通"的信息操作。
 *
 * fail-closed：空事件 / 空分支抛错；无共振(全 < 阈值)的查询 → conduct 返回 []。
 */

/** 一条刻蚀分支（可递归嵌套，构成分形决策树）。 */
export interface EtchBranch {
  /** 分支标签（决策节点摘要）。 */
  readonly label: string;
  /** 子分支（更深一层决策）。 */
  readonly subBranches?: readonly EtchBranch[];
}

/** 一次顿悟事件（待刻蚀）。 */
export interface EtchEvent {
  /** 唯一 ID。 */
  readonly id: string;
  /** 事件主标签。 */
  readonly label: string;
  /** 分支决策树（分形 trace 的骨架）。 */
  readonly branches?: readonly EtchBranch[];
}

/** 刻蚀后的分支节点（递归树）。 */
export interface EtchNode {
  /** 节点 ID。 */
  readonly id: string;
  /** 节点标签。 */
  readonly label: string;
  /** 子节点。 */
  readonly children: readonly EtchNode[];
}

/** 一条已刻蚀的 trace（永久留存的分形刻痕）。 */
export interface EtchTrace {
  /** trace ID（== 事件 ID）。 */
  readonly id: string;
  /** 分形分支树根。 */
  readonly root: EtchNode;
  /** 创建时间（ISO）。 */
  readonly createdAt: string;
}

/** 沿刻痕低阻导通的结果（分支路径即低阻通道）。 */
export interface EtchConduction {
  /** 命中的 trace ID。 */
  readonly traceId: string;
  /** query 与该 trace 的共振强度。 */
  readonly resonance: number;
  /** 沿刻痕导通的分支路径标签序列。 */
  readonly path: readonly string[];
}

/** 刻蚀记忆端口。 */
export interface InsightEtchingPort {
  readonly name: string;
  /**
   * 刻蚀一次顿悟事件：在记忆介质上刻出分形分支决策树。
   * fail-closed：空 ID / 空标签的事件抛错。
   */
  etch(event: EtchEvent): EtchTrace;
  /**
   * 沿与 query 共振最强的刻痕低阻导通，返回 top-k 分支路径。
   * 无任何 trace 共振 ≥ 阈值时返回 []（沿痕不通，正常回落检索）。
   */
  conduct(query: string, k?: number): readonly EtchConduction[];
  /** 已刻蚀 trace 数。 */
  readonly traces: number;
}
