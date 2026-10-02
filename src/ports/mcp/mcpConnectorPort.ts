/**
 * MCP 连接器端口：从「服务器配置」到「已握手的连接」。
 *
 * ## 为什么需要
 *
 * 手写 `McpConnector`（src/mcp）只会 spawn 本地 stdio 子进程；官方 SDK 连接器
 * （src/adapters/mcp）会按配置走 stdio 或 Streamable HTTP/SSE 远端。
 * MCP 网关（mcpGateway）不应关心这个分叉——它只吃本端口，由组合根决定注入哪个实现
 * （生产注入「SDK 优先、手写回退」的偏好连接器，测试注入手写实现）。
 */
import type { McpClientPort } from './mcpClientPort.js';
import type { McpInitializeResult } from './mcpProtocolTypes.js';
import type { McpServerConfig } from './mcpServerConfig.js';

/**
 * @beta
 * 已建立的连接（握手完成）。
 */
export interface McpConnectionHandle {
  /** 可用的客户端（握手已完成）。 */
  readonly client: McpClientPort;
  /** 握手返回的服务端信息。 */
  readonly info: McpInitializeResult;
  /** 关闭连接（幂等：重复调用无副作用）。 */
  readonly close: () => void;
}

/**
 * @beta
 * MCP 连接器端口。
 */
export interface McpConnectorPort {
  /**
   * 建立连接（握手成功返回，失败关闭底层资源并抛出）。
   *
   * @param server 服务器配置（stdio 给 command/args/env/cwd；远端给 url）。
   * @param timeoutMs 请求超时（毫秒；缺省由实现决定）。
   * @returns 连接句柄（client + init 信息 + close）。
   */
  connect(server: McpServerConfig, timeoutMs?: number | undefined): Promise<McpConnectionHandle>;
}
