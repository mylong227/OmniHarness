/**
 * 非牛顿固化存储端口（燧-2 原语，零依赖，实验性 @beta）。
 *
 * 把「剪切增稠非牛顿流体（oobleck）」的力学行为抽象为存储语义：
 * - 低应力（冲击 < 屈服应力 τ）下处于「液态」：可反复覆盖写入，状态松弛。
 * - 单笔写入的冲击一旦越过 τ，材料「剪切增稠」并**永久冻结**（rig=1），提交在那一刻发生。
 * - 冻结后任何写入/删除均被拒绝（fail-closed，不可变）。
 *
 * 关键差异（市面无对应原语）：冻结是「某笔写入的冲击越过阈值」**涌现**出来的，
 * 而不是由某个显式 `freeze()` 调用触发的——提交语义是冲击涌现的，而非命令式写。
 */
export interface OobleckRecord {
  /** 当前值。 */
  readonly value: string;
  /** 是否已冻结（rig>=1）。 */
  readonly frozen: boolean;
  /** 该存储实例的屈服应力阈值。 */
  readonly yieldStress: number;
}

/** 提议写入的结果。 */
export interface OobleckWriteResult {
  /** 是否被接受（冻结后一律 false）。 */
  readonly accepted: boolean;
  /** 本次写入是否导致了冻结（冲击越过 τ）。 */
  readonly frozen: boolean;
  /** 拒绝原因。 */
  readonly reason?: 'frozen' | 'liquid' | 'yield';
}

/** 非牛顿固化存储端口：提交由冲击涌现，冻结后不可变。 */
export interface OobleckPort {
  readonly name: string;

  /**
   * 以给定冲击幅度 `impact` 提议写入 `value`。
   * - `impact >= yieldStress`：剪切增稠，提交并**冻结**（emergent，非显式调用）。
   * - `impact < yieldStress` 且未冻结：液态覆盖，状态松弛。
   * - 已冻结：拒绝（fail-closed）。
   */
  propose(key: string, value: string, impact: number): Promise<OobleckWriteResult>;

  /** 读取记录（含冻结态）。 */
  get(key: string): Promise<OobleckRecord | undefined>;

  /** 是否已冻结。 */
  isFrozen(key: string): Promise<boolean>;

  /** 删除：液态下允许；冻结后拒绝（不可变）。 */
  delete(key: string): Promise<boolean>;

  /** 关闭底层资源。 */
  close(): Promise<void>;
}
