import type { ToolDefinition } from './toolDefinition.js';
import type { ToolCall } from './toolCall.js';
import type { ToolContext } from './toolContext.js';
import type { ToolResult } from './toolResult.js';

/** 工具端口：一切工具能力（内置/外部服务/自定义）的统一插口。 */
export interface ToolPort {
  readonly name: string;
  list(): readonly ToolDefinition[];
  execute(call: ToolCall, context: ToolContext): Promise<ToolResult>;
  /**
   * 反注册工具（插件卸载时回收其注册的工具，避免孤儿工具残留）。
   * 可选：不支持反注册的端口可省略，此时插件工具在卸载后仍需手动清理。
   */
  unregister?(name: string): boolean;
  /**
   * 供模型上下文使用的工具子集（剔除 deferred 工具）。
   * 缺省回退 `list()`；延迟加载机制依赖此方法与 `tool_search` 协同（#M1）。
   */
  listDirect?(): readonly ToolDefinition[];
}
