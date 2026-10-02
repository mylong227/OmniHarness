import { McpClient } from './mcpClient.js';
import { mcpStdioTransport, type McpStdioServerOptions } from './mcpStdioTransport.js';
import type { McpConnectionHandle, McpConnectorPort } from '../ports/mcp/mcpConnectorPort.js';
import type { McpServerConfig } from '../ports/mcp/mcpServerConfig.js';

/**
 * @beta
 * 已建立的连接（握手完成）。
 *
 * 2026-10-02 起为 ports 层 {@link McpConnectionHandle} 的别名：client 放宽为
 * {@link McpClientPort}（官方 SDK 适配器同样满足），消费方零改动。
 */
export type McpConnection = McpConnectionHandle;

/**
 * @beta
 * 连接器选项（stdio 形态）。
 */
export interface McpConnectorOptions extends McpStdioServerOptions {
  readonly timeoutMs?: number | undefined;
}

/**
 * @beta
 * MCP 连接器：启动外部服务器 → 握手 → 返回可用客户端（启动失败即抛错）。
 *
 * 2026-10-02 起实现 ports 层 {@link McpConnectorPort}，并支持**两种服务器形态**：
 * - stdio（`command`）：本类原有的 spawn 路径，行为不变；
 * - 远端 `url`（http/https）：**本手写实现不支持**——显式抛可行动错误
 *   （官方 SDK 连接器 src/adapters/mcp 才具备该能力），绝不静默 spawn 空命令。
 *
 * 无状态连接逻辑以实例方法暴露，由组合根单例 `mcpConnector` 统一装配。
 */
export class McpConnector implements McpConnectorPort {
  /**
   * 建立连接（握手成功返回，失败关闭子进程并抛出）。
   * @param server 服务器配置（stdio 形态：command/args/env/cwd）。
   * @param timeoutMs 请求超时（毫秒；缺省 10000）。
   * @returns 连接句柄（client + init 信息 + close）
   */
  public async connect(
    server: McpServerConfig,
    timeoutMs?: number | undefined,
  ): Promise<McpConnection> {
    if (server.url !== undefined) {
      throw new Error(
        `手写 MCP 连接器只支持本地 stdio 服务器；"server.url=${server.url}" 需要官方 SDK 连接器` +
          '（生产装配默认走 SDK，若见此报错说明被显式切回了手写实现）',
      );
    }
    if (server.command === undefined) {
      throw new Error(
        `MCP 服务器 "${server.name}" 既无 command 也无 url：请在配置里给出二选一` +
          '（本地进程给 command，远端服务器给 http/https url）',
      );
    }
    const options: McpConnectorOptions = {
      command: server.command,
      // exactOptionalPropertyTypes：可选字段只在有值时写入，不显式塞 undefined。
      ...(server.args !== undefined ? { args: server.args } : {}),
      ...(server.env !== undefined ? { env: server.env } : {}),
      ...(server.cwd !== undefined ? { cwd: server.cwd } : {}),
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    };
    const handle = mcpStdioTransport.launch(options);
    try {
      const client = new McpClient({ transport: handle.transport, timeoutMs });
      const info = await Promise.race([client.initialize(), handle.failure]);
      // 关闭顺序有讲究：**先**拒绝在途请求（`client.close()`），**再**关传输/子进程。
      // 反过来的话，`Transport` 契约没有关闭通知 ⇒ 在途请求只能等各自超时（默认 10s）
      // 才被拒，调用方在此期间表现为「卡住」（审计 §3.5 记录的形态）。
      return {
        client,
        info,
        close: () => {
          client.close('MCP 连接已关闭');
          handle.close();
        },
      };
    } catch (error) {
      handle.close();
      throw error;
    }
  }
}

/** 组合根单例：MCP 连接逻辑的装配点。 */
export const mcpConnector = new McpConnector();
