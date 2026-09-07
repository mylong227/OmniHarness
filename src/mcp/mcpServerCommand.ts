import type { McpBridgeResult, McpServerConfig } from './mcpGateway.js';

/**
 * @beta
 * 解析 `NAME=COMMAND [ARGS...]` 形式的 MCP 服务器参数。
 */
export function parseMcpServerSpec(value: string): McpServerConfig {
  const separator = value.indexOf('=');
  if (separator <= 0) {
    throw new Error(`--mcp-server 格式应为 NAME=COMMAND [ARGS...]，实际: ${value}`);
  }
  const name = value.slice(0, separator).trim();
  const parts = value
    .slice(separator + 1)
    .trim()
    .split(/\s+/)
    .filter((part) => part !== '');
  const command = parts[0];
  if (name === '' || command === undefined) {
    throw new Error(`--mcp-server 格式应为 NAME=COMMAND [ARGS...]，实际: ${value}`);
  }
  return { name, command, args: parts.slice(1) };
}

/**
 * @beta
 * 汇总桥接结果为一行文本。
 */
export function formatBridgeResults(results: readonly McpBridgeResult[]): string {
  return results
    .map((result) =>
      result.error === undefined
        ? `${result.server}: ${result.tools.length} 工具${result.tools.length > 0 ? ` (${result.tools.join(', ')})` : ''}`
        : `${result.server}: 失败 - ${result.error}`,
    )
    .join('\n');
}
