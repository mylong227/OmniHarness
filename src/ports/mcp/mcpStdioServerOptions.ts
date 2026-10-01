/**
 * 外部 MCP 服务器启动参数。
 *
 * 已从 `mcp/mcpStdioTransport.ts` 外迁到 ports/mcp：原文件退化为纯再导出桶，调用点零改动。
 * @beta
 */
export interface McpStdioServerOptions {
  readonly command: string;
  readonly args?: readonly string[];
  readonly env?: Record<string, string>;
  readonly cwd?: string;
}
