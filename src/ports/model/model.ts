// 桶文件：保留原 `src/ports/model/model.ts` 的全部导出，调用点零改动。
// 每个接口已拆分为 `./<接口名>.ts`（一接口一文件，见 docs/archive/INTERFACE_REFACTOR_QUEUE.md Batch A）。

export type { ImageContent } from './imageContent.ts';
export type { FileAttachment } from './fileAttachment.ts';
export type { ModelMessage } from './modelMessage.ts';
export type { ModelToolSpec } from './modelToolSpec.ts';
export type { ModelRequest } from './modelRequest.ts';
export type {
  JsonObjectResponseFormat,
  JsonSchemaResponseFormat,
  ModelResponseFormat,
  TextResponseFormat,
} from './modelResponseFormat.ts';
export type { ModelToolCallRef } from './modelToolCallRef.ts';
export type { ModelOutput } from './modelOutput.ts';
export type { ModelUsage } from './modelUsage.ts';
export type { ContextCategoryKey } from './contextCategoryKey.ts';
export type { ModelContextSnapshot } from './modelContextSnapshot.ts';
export type { ToolInputDelta } from './toolInputDelta.ts';
export type { StreamCallbacks } from './streamCallbacks.ts';
export type { ModelPort } from './modelPort.ts';
export type { RoutePrice } from './routePrice.ts';

// 错误实现已迁至 errors/，此处仅作值再导出（保持 src/ports/index.ts 与消费方的
// `export { ModelCallError, BudgetExceededError }` 导出面不变）。
/** 模型调用错误（结构化，便于重试决策；#M6）。实现已迁至 `errors/modelCallError.ts`。 */
export { ModelCallError } from '../../errors/modelCallError.ts';
/** 成本预算耗尽错误（#S29）。实现已迁至 `errors/budgetExceededError.ts`。 */
export { BudgetExceededError } from '../../errors/budgetExceededError.ts';
