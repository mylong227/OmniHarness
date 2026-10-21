import { McpClient } from './mcpClient.ts';
import { McpStatelessClient } from './mcpStatelessClient.ts';
import { McpProtocolNegotiator, type McpProtocolChoice } from './mcpProtocolNegotiator.ts';
import { mcpStdioTransport, type McpStdioServerOptions } from './mcpStdioTransport.ts';
import type { McpConnectionHandle, McpConnectorPort } from '../ports/mcp/mcpConnectorPort.ts';
import type { McpServerConfig } from '../ports/mcp/mcpServerConfig.ts';
import { log } from '../util/logger.ts';

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
   * server 是否在允许清单内（SEC-04）。
   *
   * `OMNI_MCP_ALLOW` / `OMNI_MCP_ALLOWLIST` 为空/未设 ⇒ 不启用白名单（兼容既有配置）；设置后只允许
   * 逗号分隔的 server 名，未登记一律拒连（fail-closed，而不是“先连上再问”）。
   * 两个环境变量名是历史分叉（连接器用前者、网关用后者）：2026-10-21 起**互为回退**，
   * 避免「只设了一个名字，另一条路径不生效」。
   * @param name server 名。
   * @param env 环境变量（测试可注入）。
   * @returns 允许时为 true。
   */
  public static isAllowed(name: string, env: NodeJS.ProcessEnv = process.env): boolean {
    const raw = env['OMNI_MCP_ALLOW'] ?? env['OMNI_MCP_ALLOWLIST'];
    if (raw === undefined || raw.trim() === '') return true;
    return raw
      .split(',')
      .map((item) => item.trim())
      .filter((item) => item !== '')
      .includes(name);
  }

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
    if (!McpConnector.isAllowed(server.name)) {
      throw new Error(
        `MCP server "${server.name}" 不在 OMNI_MCP_ALLOW 白名单内（SEC-04 fail-closed）`,
      );
    }
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
      const opened = await McpConnector.handshake(
        handle,
        timeoutMs,
        McpProtocolNegotiator.select(),
      );
      // 关闭顺序有讲究：**先**拒绝在途请求（`client.close()`），**再**关传输/子进程。
      // 反过来的话：`Transport` 契约没有关闭通知 ⇒ 在途请求只能等各自超时（默认 10s）
      // 才被拒，调用方在此期间表现为「卡住」（审计 §3.5 记录的形态）。
      return {
        client: opened.client,
        info: opened.info,
        close: () => {
          opened.client.close('MCP 连接已关闭');
          handle.close();
        },
        // 2026-10-21：进程退出/传输失败时通知网关（此前只能等下一次调用超时才暴露）。
        onExit: (listener) => {
          void handle.failure.catch(() => {
            listener();
          });
        },
      };
    } catch (error) {
      handle.close();
      throw error;
    }
  }

  /**
   * 按协商结果完成握手；`auto` 先尝试 v2 无状态发现，失败回退 legacy。
   *
   * 为什么可以复用同一 transport：`McpStatelessClient.close()` 只拒绝在途请求、
   * 不关闭子进程/管道，故一次失败的 `server/discover` 之后仍可用旧栈 `initialize`。
   * @param handle stdio 传输句柄。
   * @param timeoutMs 请求超时。
   * @param choice 协议选择（legacy / stateless-v2 / auto）。
   * @returns 已握手的客户端与初始化信息。
   */
  private static async handshake(
    handle: ReturnType<typeof mcpStdioTransport.launch>,
    timeoutMs: number | undefined,
    choice: McpProtocolChoice,
  ): Promise<{ client: McpConnection['client']; info: McpConnection['info'] }> {
    if (choice !== 'auto') {
      return await McpConnector.openWith(handle, timeoutMs, choice);
    }
    const v2 = new McpStatelessClient({ transport: handle.transport, timeoutMs });
    try {
      const info = await Promise.race([v2.initialize(), handle.failure]);
      return { client: v2, info };
    } catch (error) {
      v2.close('MCP 2026-07-28 探测失败，回退 legacy');
      log.info('mcp.protocol.fallback', {
        from: 'stateless-v2',
        to: 'legacy',
        error: error instanceof Error ? error.message : String(error),
      });
      return await McpConnector.openWith(handle, timeoutMs, 'legacy');
    }
  }

  /**
   * 用指定协议栈完成握手。
   * @param handle stdio 传输句柄。
   * @param timeoutMs 请求超时。
   * @param choice 显式协议（legacy / stateless-v2）。
   * @returns 已握手的客户端与初始化信息。
   */
  private static async openWith(
    handle: ReturnType<typeof mcpStdioTransport.launch>,
    timeoutMs: number | undefined,
    choice: Exclude<McpProtocolChoice, 'auto'>,
  ): Promise<{ client: McpConnection['client']; info: McpConnection['info'] }> {
    const client =
      choice === 'stateless-v2'
        ? new McpStatelessClient({ transport: handle.transport, timeoutMs })
        : new McpClient({ transport: handle.transport, timeoutMs });
    const info = await Promise.race([client.initialize(), handle.failure]);
    return { client, info };
  }
}

/** 组合根单例：MCP 连接逻辑的装配点。 */
export const mcpConnector = new McpConnector();
