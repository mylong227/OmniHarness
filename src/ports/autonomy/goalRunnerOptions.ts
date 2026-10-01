/** 自主目标循环选项（@beta）。 */
export interface GoalRunnerOptions {
  /** 最大迭代次数（默认 10）；每轮 = 一次回合推进 + 一次达成度判定。 */
  readonly maxIterations?: number | undefined;
  /** 父会话取消信号（可选）：置位后不再开启下一轮迭代；缺省 undefined＝不传播取消。 */
  readonly signal?: AbortSignal | undefined;
}
