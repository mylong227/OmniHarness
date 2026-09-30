/**
 * verdict 观测相关类型。从 `selfVerifyingToolPort` 抽出至中性模块，
 * 以打断 `selfVerifyingToolPort ↔ verdictTracer` 的循环依赖（架构门禁 [5]）：
 * 原先 `selfVerifyingToolPort` 值导入 `VerdictTracer`、`verdictTracer` 类型导入 `VerdictObserver`，
 * 形成 2 成员环；把共享类型放到本叶节点后，两条边都改为指向此处，环消除。
 */

/**
 * Laya verdict 观测记录（shadow 档）：记录 System-1 预判与最终真实结果，供后续评估
 * 决策引擎能否升级为 enforce（替代部分 LLM 推理）积累自有 trace。
 */
export interface VerdictObservation {
  /** 会话 id。 */
  readonly sessionId: string;
  /** 触发自验证的工具名。 */
  readonly toolName: string;
  /** `noul` 原语给出的「改动会过测试」概率（[0,1]）；不可用为 undefined。 */
  readonly noul: number | undefined;
  /** 引擎是否可用。 */
  readonly available: boolean;
  /** 不可用 / 退化原因（可选）。 */
  readonly note?: string;
}

/** 可选的 verdict 观测回调（缺省无操作；组合根可注入 telemetry 落盘）。 */
export type VerdictObserver = (observation: VerdictObservation) => void;
