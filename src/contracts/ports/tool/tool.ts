/**
 * 工具端口契约聚合（桶）。
 *
 * 本文件已退化为桶：6 个接口各自独立成文件于 `./tool/`，调用点零改动。
 */

export type { ToolParametersSchema } from './tool/toolParametersSchema.ts';
export type { ToolDefinition } from './tool/toolDefinition.ts';
export type { ToolCall } from './tool/toolCall.ts';
export type { ToolResult } from './tool/toolResult.ts';
export type { ToolContext } from './tool/toolContext.ts';
export type { ToolPort } from './tool/toolPort.ts';
