import type { Candidate } from './candidate.js';

/**
 * 档案条目：入档候选 + 其工况桶 + 冻结状态。
 *
 * 档案是「待裁决对象」的保留层（MAP-Elites 思想）：按工况桶保留精英，
 * **冻结不删除**（负结果留档，防「评估集偏差判死好变异」），同工况复现时复活。
 */
export interface ArchivedCandidate {
  /** 入档候选。 */
  readonly candidate: Candidate;
  /** 工况桶键（语义由调用方声明；本端口只做分桶容器）。 */
  readonly bucketKey: string;
  /** 精英得分（桶内排序依据，0..1 或任意可比标量）。 */
  readonly score: number;
  /** 冻结原因；`undefined` = 未冻结。 */
  readonly frozenReason?: string | undefined;
  /** 入档序号（同分时保证确定性排序）。 */
  readonly seq: number;
}

/**
 * 候选档案端口（GEE Kernel ② expand 环）：按工况桶保留精英、冻结不删除、同工况复活。
 *
 * 实现须确定性：桶内排序（得分降序，同分按入档序）恒稳定；`put` 超出桶容量时
 * 淘汰桶内低分者（绝不无界膨胀）。冻结是**标记**不是删除——被冻结条目退出 `elites()`
 * 流，但保留在档，等 `reviveFor` 按工况复活。
 */
export interface CandidateArchivePort {
  /**
   * 入档：把候选放入指定工况桶（桶内按得分保留精英，超限淘汰低分者）。
   * @param candidate 待入档候选
   * @param bucketKey 工况桶键
   * @param score 精英得分（同分时先入者保序）
   * @returns 无返回值（void）
   */
  put(candidate: Candidate, bucketKey: string, score: number): void;
  /**
   * 桶内未冻结精英（得分降序，同分按入档序）。
   * @param bucketKey 工况桶键
   * @returns 该桶当前有效的精英条目（快照副本）
   */
  elites(bucketKey: string): readonly ArchivedCandidate[];
  /**
   * 冻结（不删除）：按候选键（技能名）标记冻结并记录原因。
   * @param key 候选键（技能名）
   * @param reason 冻结原因（进审计）
   * @returns true = 存在该条目且已冻结；false = 无此条目（幂等 no-op）
   */
  freeze(key: string, reason: string): boolean;
  /**
   * 工况复现复活：解冻该桶**全部**冻结条目并返回（得分降序，同分按入档序）。
   * @param bucketKey 工况桶键
   * @returns 复活条目（快照副本；无冻结条目为空数组）
   */
  reviveFor(bucketKey: string): readonly ArchivedCandidate[];
}
