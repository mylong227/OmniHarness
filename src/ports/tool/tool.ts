/**
 * 工具端口契约聚合（桶）。
 *
 * 本文件已退化为桶：6 个接口各自独立成文件于 `./tool/`，调用点零改动。
 */

export type { ToolParametersSchema } from './tool/toolParametersSchema.js';
export type { ToolDefinition } from './tool/toolDefinition.js';
export type { ToolCall } from './tool/toolCall.js';
export type { ToolResult } from './tool/toolResult.js';
export type { ToolContext } from './tool/toolContext.js';
export type { ToolPort } from './tool/toolPort.js';
