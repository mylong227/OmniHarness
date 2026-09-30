import type { ModelToolCallRef } from './modelToolCallRef.js';
import type { ModelUsage } from './modelUsage.js';

/** 模型输出：推理 / 文本 / 工具调用。 */
export interface ModelOutput {
  readonly reasoning?: string | undefined;
  readonly text?: string | undefined;
  readonly toolCalls?: readonly ModelToolCallRef[] | undefined;
  /** 本次调用的 token 用量（成本计量 / 硬预算熔断依据，#S29）。未上报时为 undefined。 */
  readonly usage?: ModelUsage | undefined;
}
