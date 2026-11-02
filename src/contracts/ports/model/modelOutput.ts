import type { ModelToolCallRef } from './modelToolCallRef.ts';
import type { ModelUsage } from './modelUsage.ts';

/** 模型输出：推理 / 文本 / 工具调用。 */
export interface ModelOutput {
  readonly reasoning?: string | undefined;
  /**
   * 思考块签名（Anthropic `signature_delta`）：续接 thinking 块必须原样回传。
   * 未上报时缺省（旧适配器/端点不受影响）。
   */
  readonly reasoningSignature?: string | undefined;
  readonly text?: string | undefined;
  readonly toolCalls?: readonly ModelToolCallRef[] | undefined;
  /** 本次调用的 token 用量（成本计量 / 硬预算熔断依据，#S29）。未上报时为 undefined。 */
  readonly usage?: ModelUsage | undefined;
  /**
   * 结束原因（2026-10-20，LR-01）：`stop` / `length` / `tool_calls` / `content_filter` / 其它厂商值。
   *
   * 为什么必须保留：输出被 `length` 截断时，半截文本/半截工具参数若被当成“完成”，
   * 上层会把截断读成收尾。`StepRunner` 据此触发续写（最多 3 次）。未上报时为 undefined
   * （旧适配器/端点不提供 ⇒ 保持既有行为，不臆造 `stop`）。
   */
  readonly finishReason?: string | undefined;
}
