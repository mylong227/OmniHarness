import { McpClient } from './mcpClient.js';
import { mcpStdioTransport, type McpStdioServerOptions } from './mcpStdioTransport.js';
import type { McpInitializeResult } from './mcpProtocol.js';

/**
 * @beta
 * 已建立的连接（握手完成）。
 */
export interface McpConnection {
  readonly client: McpClient;
  readonly info: McpInitializeResult;
  readonly close: () => void;
}

/**
 * @beta
 * 连接器选项。
 */
export interface McpConnectorOptions extends McpStdioServerOptions {
  readonly timeoutMs?: number;
}

/**
 * @beta
 * MCP 连接器：启动外部服务器 → 握手 → 返回可用客户端（启动失败即抛错）。
 *
 * 无状态连接逻辑以实例方法暴露，由组合根单例 `mcpConnector` 统一装配。
 */
export class McpConnector {
  /** 建立连接（握手成功返回，失败关闭子进程并抛出）。 */
  public async connect(options: McpConnectorOptions): Promise<McpConnection> {
    const handle = mcpStdioTransport.launch(options);
    try {
      const client = new McpClient({ transport: handle.transport, timeoutMs: options.timeoutMs });
      const info = await Promise.race([client.initialize(), handle.failure]);
      return { client, info, close: () => handle.close() };
    } catch (error) {
      handle.close();
      throw error;
    }
  }
}

/** 组合根单例：MCP 连接逻辑的装配点。 */
export const mcpConnector = new McpConnector();
