/**
 * 官方 SDK MCP 连接器（真实实现）：按服务器配置选择传输并完成握手。
 *
 * ## 两种形态
 *
 * - **stdio**（`command`）：`StdioClientTransport` spawn 本地子进程；
 * - **远端 url**（http/https）：优先 `StreamableHTTPClientTransport`（现行标准），
 *   失败回落 `SSEClientTransport`（大量存量服务器仍是 SSE-only）——回落**如实记录**，
 *   绝不静默。
 *
 * 手写 `McpConnector`（src/mcp）只会 spawn stdio，远端 url 完全缺位——这正是
 * 客户端方向迁官方 SDK 的能力增量（allowlist @modelcontextprotocol/sdk 条目 ②）。
 */
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { StdioServerParameters } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { SdkMcpClientAdapter, type SdkMcpClientOptions } from './sdkMcpClientAdapter.js';
import type { McpConnectionHandle, McpConnectorPort } from '../../ports/mcp/mcpConnectorPort.js';
import type { McpServerConfig } from '../../ports/mcp/mcpServerConfig.js';
import { log } from '../../util/logger.js';

/** 连接器选项（客户端元数据）。 */
export interface SdkMcpConnectorOptions {
  /** 对外上报的客户端名（缺省 `omniharness`）。 */
  readonly clientName?: string | undefined;
  /** 对外上报的客户端版本（缺省 `0.1.0`）。 */
  readonly clientVersion?: string | undefined;
}

/**
 * 官方 SDK MCP 连接器：stdio / 远端 url 二形态，握手失败抛错并关闭底层资源。
 */
export class SdkMcpConnector implements McpConnectorPort {
  /** 缺省客户端元数据。 */
  private static readonly DEFAULT_CLIENT = { name: 'omniharness', version: '0.1.0' };

  /**
   * @param options 客户端元数据（缺省 omniharness）。
   */
  public constructor(private readonly options: SdkMcpConnectorOptions = {}) {}

  /**
   * 建立连接（握手成功返回，失败关闭底层资源并抛出）。
   *
   * @param server 服务器配置（stdio 给 command/args/env/cwd；远端给 url）。
   * @param timeoutMs 每请求超时（毫秒；缺省由 SDK 决定）。
   * @returns 连接句柄（client + init 信息 + close）。
   */
  public async connect(
    server: McpServerConfig,
    timeoutMs?: number | undefined,
  ): Promise<McpConnectionHandle> {
    const clientOptions: SdkMcpClientOptions = {
      clientName: this.options.clientName ?? SdkMcpConnector.DEFAULT_CLIENT.name,
      clientVersion: this.options.clientVersion ?? SdkMcpConnector.DEFAULT_CLIENT.version,
      timeoutMs,
    };
    if (server.url !== undefined) {
      return await SdkMcpConnector.connectRemote(server, clientOptions);
    }
    return await SdkMcpConnector.connectStdio(server, clientOptions);
  }

  /**
   * stdio 形态：spawn 本地子进程并握手。
   *
   * @param server 服务器配置（必须含 command）。
   * @param clientOptions 客户端选项。
   * @returns 连接句柄。
   */
  private static async connectStdio(
    server: McpServerConfig,
    clientOptions: SdkMcpClientOptions,
  ): Promise<McpConnectionHandle> {
    if (server.command === undefined) {
      throw new Error(`MCP 服务器 "${server.name}" 缺 command（stdio 形态必填）`);
    }
    // exactOptionalPropertyTypes：可选字段只在有值时写入，不显式塞 undefined。
    const parameters: StdioServerParameters = { command: server.command };
    if (server.args !== undefined) {
      parameters.args = [...server.args];
    }
    if (server.env !== undefined) {
      parameters.env = { ...server.env };
    }
    if (server.cwd !== undefined) {
      parameters.cwd = server.cwd;
    }
    const transport = new StdioClientTransport(parameters);
    try {
      const client = await SdkMcpClientAdapter.connect(transport, clientOptions);
      const info = await client.initialize();
      return {
        client,
        info,
        close: () => {
          client.close();
          void transport.close();
        },
      };
    } catch (error) {
      await transport.close().catch(() => undefined);
      throw error;
    }
  }

  /**
   * 远端形态：Streamable HTTP 优先，失败回落 SSE（回落如实记录日志）。
   *
   * @param server 服务器配置（必须含 http/https url）。
   * @param clientOptions 客户端选项。
   * @returns 连接句柄。
   */
  private static async connectRemote(
    server: McpServerConfig,
    clientOptions: SdkMcpClientOptions,
  ): Promise<McpConnectionHandle> {
    const url = server.url;
    if (!/^https?:\/\//i.test(url ?? '')) {
      throw new Error(
        `MCP 服务器 "${server.name}" 的 url 必须是 http/https（实际: ${url ?? '缺失'}）`,
      );
    }
    const target = new URL(url as string);
    try {
      return await SdkMcpConnector.connectWith(
        // SDK 自身的 StreamableHTTP 类型在 exactOptionalPropertyTypes 下与 Transport 接口
        // 存在已知的属性型变摩擦（sessionId: string | undefined vs sessionId?: string），
        // 与运行时行为无关，此处按官方继承关系显式收口。
        () => new StreamableHTTPClientTransport(target) as unknown as Transport,
        clientOptions,
      );
    } catch (streamableError) {
      log.info('mcp.sdk.remote.fallback_sse', {
        server: server.name,
        reason:
          streamableError instanceof Error ? streamableError.message : String(streamableError),
      });
      return await SdkMcpConnector.connectWith(
        () => new SSEClientTransport(target) as unknown as Transport,
        clientOptions,
      );
    }
  }

  /**
   * 用给定传输工厂建立并握手（失败关闭底层资源后原样抛出）。
   *
   * @param createTransport 传输工厂（每次调用给全新实例，避免重连复用脏传输）。
   * @param clientOptions 客户端选项。
   * @returns 连接句柄。
   */
  private static async connectWith(
    createTransport: () => Transport,
    clientOptions: SdkMcpClientOptions,
  ): Promise<McpConnectionHandle> {
    const transport = createTransport();
    try {
      const client = await SdkMcpClientAdapter.connect(transport, clientOptions);
      const info = await client.initialize();
      return {
        client,
        info,
        close: () => {
          client.close();
          void transport.close();
        },
      };
    } catch (error) {
      await transport.close().catch(() => undefined);
      throw error;
    }
  }
}
