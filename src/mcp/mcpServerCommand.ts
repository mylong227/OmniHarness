import type { McpBridgeResult, McpServerConfig } from './mcpGateway.js';

/**
 * McpServerCommand —— 由本文件原顶层函数归并而来（每个方法对应一个原函数，语义与签名逐字保留）。
 */
export class McpServerCommand {
  /**
   * @beta
   * 解析 `NAME=COMMAND [ARGS...]` 形式的 MCP 服务器参数。
   */
  public static parseMcpServerSpec(value: string): McpServerConfig {
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
  public static formatBridgeResults(results: readonly McpBridgeResult[]): string {
    return results
      .map((result) =>
        result.error === undefined
          ? `${result.server}: ${result.tools.length} 工具${result.tools.length > 0 ? ` (${result.tools.join(', ')})` : ''}`
          : `${result.server}: 失败 - ${result.error}`,
      )
      .join('\n');
  }
}
