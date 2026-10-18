/**
 * 步骤级过程奖励端口（P3 · process reward 监督层）。
 *
 * 口径必须诚实：这不是训练好的生成式 PRM，而是把每一次「写源码 → 跑真实测试」的
 * 步骤结果（可选 `noul` 预判）沉淀为可校准的监督样本，并提供基于历史通过率的先验。
 * 它当前只用于离线校准/影子排序，**不**直接决定工具是否执行。
 */

/** 一条步骤级奖励样本。 */
export interface StepRewardSample {
  /** 工具名。 */
  readonly toolName: string;
  /** 本次改动目标（工作区相对路径）。 */
  readonly targets: readonly string[];
  /** Laya `noul` 预判（不可用/未接时为 undefined）。 */
  readonly noul?: number | undefined;
  /** 真实测试是否通过。 */
  readonly passed: boolean;
  /** 退出码（超时/未跑时为 null）。 */
  readonly exitCode: number | null;
  /** 记录时间（ISO）。 */
  readonly at: string;
}

/** 步骤级奖励统计（离线校准用）。 */
export interface StepRewardStats {
  /** 有效样本数。 */
  readonly samples: number;
  /** 通过样本数。 */
  readonly passes: number;
  /** 基础通过率。 */
  readonly passRate: number;
  /** 有 noul 的样本数。 */
  readonly withNoul: number;
  /** Brier（无 noul 样本时为 NaN）。 */
  readonly brier: number;
  /** AUC（某一类无 noul 样本时为 NaN）。 */
  readonly auc: number;
  /** meanP(pass) − meanP(fail)（无 noul 时为 NaN）。 */
  readonly lift: number;
}

/** 过程奖励端口。 */
export interface ProcessRewardPort {
  /**
   * 记录一条步骤级样本。
   * @param sample 样本
   * @returns 无返回值
   */
  record(sample: StepRewardSample): Promise<void>;

  /**
   * 统计当前样本的校准/区分度。
   * @returns 统计快照
   */
  stats(): Promise<StepRewardStats>;

  /**
   * 按工具名给出历史通过率先验（Laplace 平滑；无样本为 0.5）。
   * @param toolName 工具名
   * @returns [0,1] 先验
   */
  predict(toolName: string): Promise<number>;
}
