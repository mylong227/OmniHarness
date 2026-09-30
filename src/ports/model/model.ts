// 桶文件：保留原 `src/ports/model/model.ts` 的全部导出，调用点零改动。
// 每个接口已拆分为 `./<接口名>.ts`（一接口一文件，见 docs/INTERFACE_REFACTOR_QUEUE.md Batch A）。

export type { ImageContent } from './imageContent.js';
export type { FileAttachment } from './fileAttachment.js';
export type { ModelMessage } from './modelMessage.js';
export type { ModelToolSpec } from './modelToolSpec.js';
export type { ModelRequest } from './modelRequest.js';
export type { ModelToolCallRef } from './modelToolCallRef.js';
export type { ModelOutput } from './modelOutput.js';
export type { ModelUsage } from './modelUsage.js';
export type { ContextCategoryKey } from './contextCategoryKey.js';
export type { ModelContextSnapshot } from './modelContextSnapshot.js';
export type { ToolInputDelta } from './toolInputDelta.js';
export type { StreamCallbacks } from './streamCallbacks.js';
export type { ModelPort } from './modelPort.js';
export type { RoutePrice } from './routePrice.js';

// 错误实现已迁至 errors/，此处仅作值再导出（保持 src/ports/index.ts 与消费方的
// `export { ModelCallError, BudgetExceededError }` 导出面不变）。
/** 模型调用错误（结构化，便于重试决策；#M6）。实现已迁至 `errors/modelCallError.ts`。 */
export { ModelCallError } from '../../errors/modelCallError.js';
/** 成本预算耗尽错误（#S29）。实现已迁至 `errors/budgetExceededError.ts`。 */
export { BudgetExceededError } from '../../errors/budgetExceededError.js';
