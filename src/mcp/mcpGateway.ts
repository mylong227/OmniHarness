import type { ToolContext, ToolResult } from '../ports/tool/tool.js';
import type { RegistryToolPort } from '../adapters/tool/registryToolPort.js';
import { McpClient } from './mcpClient.js';
import { mcpConnector, type McpConnection } from './mcpConnector.js';
import type { McpStdioServerOptions } from './mcpStdioTransport.js';
import { mcpToolMapper } from './mcpToolMapper.js';
import type { McpCallToolResult, McpToolDescriptor } from './mcpProtocol.js';

/**
 * @beta
 * 单个 MCP 服务器配置。
 */
export interface McpServerConfig extends McpStdioServerOptions {
  /** 服务器别名（用作工具名前缀，避免跨服务器重名）。 */
  readonly name: string;
}

/**
 * @beta
 * 单个服务器的桥接结果。
 */
export interface McpBridgeResult {
  readonly server: string;
  readonly tools: readonly string[];
  readonly error?: string;
}

/**
 * @beta
 * MCP 网关选项。
 */
export interface McpGatewayOptions {
  readonly registry: RegistryToolPort;
  readonly context: ToolContext;
  readonly servers: readonly McpServerConfig[];
  readonly timeoutMs?: number;
  /**
   * 允许连接的服务器白名单（fail-closed）。
   * 非空时只连接白名单内的 server，其余一律拒绝（不发起连接）。
   * 缺省时读 process.env.OMNI_MCP_ALLOWLIST（逗号分隔）。为空=全部允许。
   */
  readonly allowedServers?: readonly string[];
}

/**
 * @beta
 * MCP 网关：连接多个外部 MCP 服务器，把远端工具桥接进本地工具注册表。
 */
export class McpGateway {
  private readonly bridged: string[] = [];
  private readonly handles: McpConnection[] = [];
  /** 解析后的 MCP 白名单（undefined=全部允许）。 */
  private readonly allowedServers: readonly string[] | undefined;

  public constructor(private readonly options: McpGatewayOptions) {
    // 选项优先，其次 env；env 为空串/未设置则回落为「全部允许」。
    const envAllow = process.env.OMNI_MCP_ALLOWLIST?.split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    this.allowedServers =
      options.allowedServers ??
      (envAllow !== undefined && envAllow.length > 0 ? envAllow : undefined);
  }

  /** 已桥接的工具名（含服务器前缀）。 */
  public bridgedTools(): readonly string[] {
    return [...this.bridged];
  }

  /** 连接全部服务器并注册工具（单服务器失败不影响其余）。 */
  public async connectAll(): Promise<readonly McpBridgeResult[]> {
    const results: McpBridgeResult[] = [];
    for (const server of this.options.servers) {
      results.push(await this.connectOne(server));
    }
    return results;
  }

  /** 连接单个服务器：握手 → 列工具 → 注册。 */
  private async connectOne(server: McpServerConfig): Promise<McpBridgeResult> {
    // fail-closed：白名单非空且当前 server 不在白名单 → 拒绝连接（不发起、记入 issues）。
    if (this.allowedServers !== undefined && !this.allowedServers.includes(server.name)) {
      return {
        server: server.name,
        tools: [],
        error: `拒绝连接：服务器 "${server.name}" 不在 MCP 白名单 (OMNI_MCP_ALLOWLIST) 中`,
      };
    }
    try {
      const connection = await mcpConnector.connect({
        ...server,
        timeoutMs: this.options.timeoutMs,
      });
      this.handles.push(connection);
      const descriptors = await connection.client.listTools();
      const names = this.registerTools(server, descriptors, connection.client);
      return { server: server.name, tools: names };
    } catch (error) {
      return { server: server.name, tools: [], error: this.messageOf(error) };
    }
  }

  /** 注册远端工具（名称加服务器前缀）。 */
  private registerTools(
    server: McpServerConfig,
    descriptors: readonly McpToolDescriptor[],
    client: McpClient,
  ): readonly string[] {
    const names: string[] = [];
    for (const descriptor of descriptors) {
      const prefixed = this.prefixedName(server.name, descriptor.name);
      if (this.bridged.includes(prefixed)) {
        continue;
      }
      const definition = mcpToolMapper.toDefinition({ ...descriptor, name: prefixed });
      this.options.registry.register(definition, (call) =>
        this.invoke(client, descriptor.name, call.id, call.arguments),
      );
      this.bridged.push(prefixed);
      names.push(prefixed);
    }
    return names;
  }

  /** 转发调用到远端服务器。 */
  private async invoke(
    client: McpClient,
    remoteName: string,
    callId: string,
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    const result = await client.callTool(remoteName, args);
    return this.toToolResult(callId, result);
  }

  /** MCP 结果 → 本地工具结果（isError 或异常均收敛为 ok:false）。 */
  private toToolResult(callId: string, result: McpCallToolResult): ToolResult {
    const text = result.content.map((entry) => entry.text).join('\n');
    return result.isError ? { callId, ok: false, error: text } : { callId, ok: true, output: text };
  }

  /** 生成带前缀的工具名。 */
  private prefixedName(serverName: string, toolName: string): string {
    return `${serverName}__${toolName}`;
  }

  /** 关闭全部子进程连接。
   * @returns 无返回值。
   */
  public close(): void {
    for (const handle of this.handles) {
      handle.close();
    }
    this.handles.length = 0;
  }

  /** 提取错误消息。 */
  private messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  /** 工具执行上下文（供测试与调用方复用）。 */
  public context(): ToolContext {
    return this.options.context;
  }
}
