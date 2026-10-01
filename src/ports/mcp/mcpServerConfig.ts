import type { McpStdioServerOptions } from './mcpStdioServerOptions.js';

/**
 * @beta
 * 单个 MCP 服务器配置。
 *
 * 已从 `mcp/mcpGateway.ts` 外迁到 ports/mcp：原文件退化为纯再导出桶，调用点零改动。
 * （同域 `McpServerOptions` 因引用 `core.ToolGate` 触发 ports→core 被禁边，暂缓。）
 */
export interface McpServerConfig extends McpStdioServerOptions {
  /** 服务器别名（用作工具名前缀，避免跨服务器重名）。 */
  readonly name: string;
}
