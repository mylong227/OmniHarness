import type { ToolCall, ToolContext, ToolResult } from './tool.js';

/** 工具处理函数。 */
export type ToolHandler = (call: ToolCall, context: ToolContext) => Promise<ToolResult>;
