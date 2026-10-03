import type { ToolContext, ToolResult } from '../ports/tool/tool.js';
import type { RegistryToolPort } from '../adapters/tool/registryToolPort.js';
import type { McpClientPort } from '../ports/mcp/mcpClientPort.js';
import type { McpConnectorPort, McpConnectionHandle } from '../ports/mcp/mcpConnectorPort.js';
import { mcpConnector } from './mcpConnector.js';
import { mcpToolMapper } from './mcpToolMapper.js';
import type { McpCallToolResult, McpToolDescriptor } from './mcpProtocol.js';
import type { McpServerConfig } from '../ports/mcp/mcpServerConfig.js';

export type { McpServerConfig } from '../ports/mcp/mcpServerConfig.js';

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
  /**
   * 连接器端口（2026-10-02 端口化）。
   * 缺省用手写 stdio 连接器（`mcpConnector`）；生产装配注入
   * 「官方 SDK 优先、手写回退」的偏好连接器（src/adapters/mcp），以获得
   * 新版协议协商与 Streamable HTTP 远端（url）服务器支持。
   */
  readonly connector?: McpConnectorPort | undefined;
}

/**
 * @beta
 * MCP 网关：连接多个外部 MCP 服务器，把远端工具桥接进本地工具注册表。
 */
export class McpGateway {
  private readonly bridged: string[] = [];
  private readonly handles: McpConnectionHandle[] = [];
  /** 解析后的 MCP 白名单（undefined=全部允许）。 */
  private readonly allowedServers: readonly string[] | undefined;
  /** 连接器（构造时收敛，缺省手写实现）。 */
  private readonly connector: McpConnectorPort;

  public constructor(private readonly options: McpGatewayOptions) {
    // 选项优先，其次 env；env 为空串/未设置则回落为「全部允许」。
    const envAllow = process.env.OMNI_MCP_ALLOWLIST?.split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    this.allowedServers =
      options.allowedServers ??
      (envAllow !== undefined && envAllow.length > 0 ? envAllow : undefined);
    this.connector = options.connector ?? mcpConnector;
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
      const connection = await this.connector.connect(server, this.options.timeoutMs);
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
    client: McpClientPort,
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
    client: McpClientPort,
    remoteName: string,
    callId: string,
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    const result = await client.callTool(remoteName, args);
    return this.toToolResult(callId, result);
  }

  /**
   * MCP 结果 → 本地工具结果（isError 或异常均收敛为 ok:false）。
   *
   * G10/T3（2026-10-03）：**结构化输出不再被丢**——`structuredContent` 以带标签的 JSON 追加到文本之后
   * （模型据此可读到机器可读字段，而不必指望远端同时给了文本块）；非文本块由适配器转述为**非空文本**
   * （`content.map(c => c.text)` 对文本块与转述块都成立 ⇒ 本方法零改动即受益）。
   * @param callId 本地工具调用 id。
   * @param result 远端 MCP 结果。
   * @returns 本仓工具结果。
   */
  private toToolResult(callId: string, result: McpCallToolResult): ToolResult {
    const text = result.content.map((entry) => entry.text).join('\n');
    const structured =
      result.structuredContent === undefined
        ? ''
        : `\n[结构化输出]\n${McpGateway.renderStructured(result.structuredContent)}`;
    const body = `${text}${structured}`;
    return result.isError ? { callId, ok: false, error: body } : { callId, ok: true, output: body };
  }

  /**
   * 渲染结构化输出（JSON 文本；不可序列化时回退为字符串描述，**绝不抛错**）。
   * @param value 结构化输出。
   * @returns 可读文本。
   */
  private static renderStructured(value: unknown): string {
    try {
      return JSON.stringify(value, null, 2) ?? String(value);
    } catch {
      return String(value);
    }
  }

  /** 生成带前缀的工具名。 */
  private prefixedName(serverName: string, toolName: string): string {
    return `${serverName}__${toolName}`;
  }

  /** 关闭全部子进程连接。
   *
   * 必须**同时**清掉 `bridged` 已桥接名册（2026-09-26 审计 X2）：它原先只清 handles，于是
   * close 之后再次 `connectAll()` 会因「名字已在 bridged 里」而**跳过注册**，而注册表里留下的
   * 仍是绑定到**旧已关闭 client** 的闭包 —— 表现是 connectAll 报成功、所有 MCP 调用全失败。
   * 一并清空名册，使重连真正重新注册。
   * @returns 无返回值。
   */
  public close(): void {
    for (const handle of this.handles) {
      handle.close();
    }
    this.handles.length = 0;
    this.bridged.length = 0;
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
