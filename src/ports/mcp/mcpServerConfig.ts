import type { McpStdioServerOptions } from './mcpStdioServerOptions.js';

/**
 * @beta
 * 单个 MCP 服务器配置。
 *
 * 已从 `mcp/mcpGateway.ts` 外迁到 ports/mcp：原文件退化为纯再导出桶，调用点零改动。
 * 同域 `McpServerOptions` 也已外迁至 `ports/mcp/mcpServerOptions.ts`，其 `gate` 现引用 ports 层
 * `ToolGatePort`（不再依赖 core 实现），`ports→core` 禁边已解除。
 */
export interface McpServerConfig extends McpStdioServerOptions {
  /** 服务器别名（用作工具名前缀，避免跨服务器重名）。 */
  readonly name: string;
}
