/** （Laya 战略线）决策引擎配置：本地 System-1 推理（choice/score/noul）替代 LLM 长推理做高频判断点。默认 off；生产开 shadow（仅观测）/ enforce（回灌 noul 预判）。质量信号非安全边界，全程 fail-open。 */
export interface DecisionEngineConfig {
  /** 生效模式：off / shadow / enforce（默认 off）。 */
  readonly mode: 'off' | 'shadow' | 'enforce';
  /** 选用的 checkpoint repo（缺省 convaiinnovations/laya-typed-decisions）。 */
  readonly repo?: string | undefined;
  /** Python 解释器路径（缺省 python3）。 */
  readonly pythonPath?: string | undefined;
  /** 是否落盘决策 trace（append-only JSONL，供 RLCD 温度校准/借鉴清单训练）。默认 true（仅当 mode≠off 时生效）。 */
  readonly trace?: boolean | undefined;
}
