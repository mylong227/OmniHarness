// 聚合桶：模型域主入口为 `./model/model.ts`（一接口一文件拆分后的桶），此处再聚合导出，
// 供习惯从 `ports/model.js` 引用的调用点使用，避免断裂。

export type {
  ImageContent,
  FileAttachment,
  ModelMessage,
  ModelToolSpec,
  ModelRequest,
  ModelToolCallRef,
  ModelOutput,
  ModelUsage,
  ContextCategoryKey,
  ModelContextSnapshot,
  ToolInputDelta,
  StreamCallbacks,
  ModelPort,
  RoutePrice,
} from './model/model.js';
export { ModelCallError, BudgetExceededError } from './model/model.js';
