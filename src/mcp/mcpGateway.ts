import type { ToolContext, ToolResult } from '../ports/tool/tool.ts';
import type { RegistryToolPort } from '../adapters/tool/registryToolPort.ts';
import type { McpClientPort } from '../ports/mcp/mcpClientPort.ts';
import type { McpConnectorPort, McpConnectionHandle } from '../ports/mcp/mcpConnectorPort.ts';
import { mcpConnector } from './mcpConnector.ts';
import { mcpToolMapper } from './mcpToolMapper.ts';
import { McpToolIntegrity } from './mcpToolIntegrity.ts';
import type { McpCallToolResult, McpToolDescriptor } from './mcpProtocol.ts';
import type { McpServerConfig } from '../ports/mcp/mcpServerConfig.ts';
import { log } from '../util/logger.ts';

export type { McpServerConfig } from '../ports/mcp/mcpServerConfig.ts';

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
 * 渲染结构化输出（JSON 文本；不可序列化时回退为字符串描述，**绝不抛错**）。
 * @param value 结构化输出。
 * @returns 可读文本。
 */
const renderStructured = (value: unknown): string => {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
};

/**
 * MCP 调用结果 → 本地 ToolResult（文本 + 结构化输出，失败带 error）。
 * @param callId 工具调用 id。
 * @param result MCP 结果。
 * @returns 本地工具结果。
 */
const toToolResult = (callId: string, result: McpCallToolResult): ToolResult => {
  const text = result.content.map((entry) => entry.text).join('\n');
  const structured =
    result.structuredContent === undefined
      ? ''
      : `\n[结构化输出]\n${renderStructured(result.structuredContent)}`;
  const body = `${text}${structured}`;
  return result.isError ? { callId, ok: false, error: body } : { callId, ok: true, output: body };
};

/**
 * @beta
 * MCP 网关：连接多个外部 MCP 服务器，把远端工具桥接进本地工具注册表。
 *
 * 2026-10-21 补齐连接生命周期：
 *  - 进程退出可感知（连接失效，下一次调用按需重连，**不自动重试已发出的调用**，
 *    避免对非幂等远端工具造成双写）；
 *  - `notifications/tools/list_changed` 到达时重新 `listTools` 并替换注册（先 unregister 旧名）；
 *  - `close()` 同时反注册已桥接工具（否则重连会撞「工具重复注册」，且旧闭包仍指向死连接）。
 */
export class McpGateway {
  private readonly bridged: string[] = [];
  /** 每台服务器当前有效的连接（键为 server.name）。 */
  private readonly connections = new Map<string, McpConnectionHandle>();
  /** 每台服务器当前有效的客户端（连接失效时删除）。 */
  private readonly clients = new Map<string, McpClientPort>();
  /** 在飞的重连 Promise（并发调用共享同一次重连，避免重复 spawn）。 */
  private readonly reconnecting = new Map<string, Promise<McpClientPort | undefined>>();
  /** 解析后的 MCP 白名单（undefined=全部允许）。 */
  private readonly allowedServers: readonly string[] | undefined;
  /** 连接器（构造时收敛，缺省手写实现）。 */
  private readonly connector: McpConnectorPort;
  /** 工具清单完整性固定（防 tool poisoning / 会话内 rug-pull）。 */
  private readonly integrity = new McpToolIntegrity();

  public constructor(private readonly options: McpGatewayOptions) {
    // 选项优先，其次 env（两个历史名字互为回退）；为空串/未设置则回落为「全部允许」。
    const envRaw = process.env.OMNI_MCP_ALLOWLIST ?? process.env.OMNI_MCP_ALLOW;
    const envAllow = envRaw
      ?.split(',')
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
      await this.open(server);
      return { server: server.name, tools: this.namesFor(server.name) };
    } catch (error) {
      return { server: server.name, tools: [], error: this.messageOf(error) };
    }
  }

  /**
   * 建立（或重建）一台服务器的连接并替换工具注册。
   * @param server 服务器配置。
   * @returns 已握手的客户端。
   */
  private async open(server: McpServerConfig): Promise<McpClientPort> {
    this.dispose(server.name);
    const connection = await this.connector.connect(server, this.options.timeoutMs);
    this.connections.set(server.name, connection);
    this.clients.set(server.name, connection.client);
    // 身份校验：旧连接迟到的 exit 回调不得删掉刚建立的新连接。
    connection.onExit?.(() => {
      if (this.connections.get(server.name) === connection) {
        this.onServerExit(server.name);
      }
    });
    connection.client.onToolsChanged?.(() => {
      void this.refresh(server);
    });
    const descriptors = await connection.client.listTools();
    this.assertToolIntegrity(server.name, descriptors);
    this.replaceTools(server, descriptors);
    return connection.client;
  }

  /**
   * 工具清单完整性闸：同一 server 的 name/description/schema 指纹变化即 fail-closed。
   *
   * 为什么在这里而不是 mapper：这是**时序**攻击面（先干净、后改描述），
   * 单条描述的字符串扫描看不见「相对上次变了」。
   * @param server 服务器名。
   * @param descriptors 最新工具描述。
   * @returns 无返回值。
   * @throws Error 指纹变化且未显式允许时抛出（调用方按连接失败处理）。
   */
  private assertToolIntegrity(server: string, descriptors: readonly McpToolDescriptor[]): void {
    const verdict = this.integrity.check(server, descriptors);
    if (verdict.ok) return;
    throw new Error(
      `MCP_TOOL_LIST_CHANGED: 服务器 "${server}" 的工具清单与首次连接不一致（${verdict.changedTools.join(
        ', ',
      )}）；拒绝替换工具注册。确认可信后可重启进程或设 OMNI_MCP_ALLOW_TOOL_CHANGES=1`,
    );
  }

  /**
   * 关闭并清理一台服务器的旧连接（重建前调用）。
   * @param name 服务器名。
   * @returns 无返回值。
   */
  private dispose(name: string): void {
    const previous = this.connections.get(name);
    if (previous === undefined) {
      return;
    }
    // 先摘登记再 close：close 会触发子进程 exit，exit 回调的身份校验必须看到「已不是当前连接」，
    // 否则一次**主动重建**会被记成 `mcp.server.exit`（噪声，且会多删一次新连接的状态）。
    this.connections.delete(name);
    this.clients.delete(name);
    try {
      previous.close();
    } catch {
      // 旧连接关闭失败不阻断重建。
    }
    this.unregisterServer(name);
  }

  /**
   * 连接失效：只标记（不反注册工具）。下一次调用走 {@link clientFor} 按需重连。
   * @param name 服务器名。
   * @returns 无返回值。
   */
  private onServerExit(name: string): void {
    this.connections.delete(name);
    this.clients.delete(name);
    log.warn('mcp.server.exit', { server: name });
  }

  /**
   * 取可用客户端；已失效则按需重连。
   * @param server 服务器配置。
   * @returns 客户端；重连失败为 undefined。
   */
  private async clientFor(server: McpServerConfig): Promise<McpClientPort | undefined> {
    const live = this.clients.get(server.name);
    if (live !== undefined) {
      return live;
    }
    const pending = this.reconnecting.get(server.name);
    if (pending !== undefined) {
      return await pending;
    }
    const task = this.reconnect(server);
    this.reconnecting.set(server.name, task);
    try {
      return await task;
    } finally {
      this.reconnecting.delete(server.name);
    }
  }

  /**
   * 重连一台服务器（失败只告警，不抛给工具调用）。
   * @param server 服务器配置。
   * @returns 新客户端；失败为 undefined。
   */
  private async reconnect(server: McpServerConfig): Promise<McpClientPort | undefined> {
    try {
      const client = await this.open(server);
      log.info('mcp.reconnected', { server: server.name });
      return client;
    } catch (error) {
      log.warn('mcp.reconnect.failed', {
        server: server.name,
        error: this.messageOf(error),
      });
      return undefined;
    }
  }

  /**
   * 工具列表变化：重新拉取并替换注册。
   * @param server 服务器配置。
   * @returns 无返回值。
   */
  private async refresh(server: McpServerConfig): Promise<void> {
    const client = this.clients.get(server.name);
    if (client === undefined) {
      return;
    }
    try {
      const descriptors = await client.listTools();
      this.assertToolIntegrity(server.name, descriptors);
      this.replaceTools(server, descriptors);
      log.info('mcp.tools.changed', { server: server.name, tools: descriptors.length });
    } catch (error) {
      log.warn('mcp.tools.refresh_failed', {
        server: server.name,
        error: this.messageOf(error),
      });
    }
  }

  /**
   * 用一份新的工具清单替换某服务器的注册（先反注册旧名，避免「工具重复注册」）。
   * @param server 服务器配置。
   * @param descriptors 最新工具描述。
   * @returns 无返回值。
   */
  private replaceTools(server: McpServerConfig, descriptors: readonly McpToolDescriptor[]): void {
    this.unregisterServer(server.name);
    for (const descriptor of descriptors) {
      const prefixed = this.prefixedName(server.name, descriptor.name);
      const definition = mcpToolMapper.toDefinition({ ...descriptor, name: prefixed });
      this.options.registry.register(definition, (call) =>
        this.invoke(server, descriptor.name, call.id, call.arguments),
      );
      this.bridged.push(prefixed);
    }
  }

  /**
   * 反注册某服务器的全部工具。
   * @param name 服务器名。
   * @returns 无返回值。
   */
  private unregisterServer(name: string): void {
    const prefix = `${name}__`;
    for (let i = this.bridged.length - 1; i >= 0; i -= 1) {
      const tool = this.bridged[i];
      if (tool !== undefined && tool.startsWith(prefix)) {
        this.options.registry.unregister(tool);
        this.bridged.splice(i, 1);
      }
    }
  }

  /** 某服务器当前桥接的工具名。 */
  private namesFor(name: string): readonly string[] {
    const prefix = `${name}__`;
    return this.bridged.filter((tool) => tool.startsWith(prefix));
  }

  /**
   * 转发调用到远端服务器（连接失效时先重连，**不自动重试已发出的调用**）。
   * @param server 服务器配置。
   * @param remoteName 远端工具名（不带前缀）。
   * @param callId 本地调用 id。
   * @param args 工具实参。
   * @returns 本地工具结果。
   */
  private async invoke(
    server: McpServerConfig,
    remoteName: string,
    callId: string,
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    const client = await this.clientFor(server);
    if (client === undefined) {
      return { callId, ok: false, error: `MCP 服务器未连接: ${server.name}` };
    }
    try {
      const result = await client.callTool(remoteName, args);
      return toToolResult(callId, result);
    } catch (error) {
      // 调用可能已产生副作用 ⇒ 不重试；标记失效，下一次调用再重连。
      this.onServerExit(server.name);
      return {
        callId,
        ok: false,
        error: `MCP 调用失败（${server.name}）: ${this.messageOf(error)}`,
      };
    }
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
  /** 生成带前缀的工具名。 */
  private prefixedName(serverName: string, toolName: string): string {
    return `${serverName}__${toolName}`;
  }

  /**
   * 关闭全部子进程连接，并**反注册**已桥接工具。
   *
   * 2026-09-26 审计 X2 只清了名册，没反注册工具 ⇒ 注册表里留下绑定旧 client 的闭包；
   * 2026-10-21 一并反注册，使 `connectAll()` 可以真正重建（否则重连必撞「工具重复注册」）。
   * @returns 无返回值。
   */
  public close(): void {
    for (const connection of this.connections.values()) {
      try {
        connection.close();
      } catch {
        // 关闭失败不阻断其余连接回收。
      }
    }
    this.connections.clear();
    this.clients.clear();
    this.reconnecting.clear();
    for (const tool of this.bridged) {
      this.options.registry.unregister(tool);
    }
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
