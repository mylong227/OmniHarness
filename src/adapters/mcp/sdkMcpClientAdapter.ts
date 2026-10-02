/**
 * 官方 SDK MCP 客户端适配器（真实实现）：用 @modelcontextprotocol/sdk 的 `Client`
 * 实现 {@link McpClientPort}。
 *
 * ## 为什么迁（2026-10-02 客户端方向扩展准入）
 *
 * 手写 `src/mcp/*` 客户端停留在 2025-06-18 握手式协议：与按新版协议协商的服务器互通时
 * 只能靠服务器向下兼容，且完全不支持 Streamable HTTP/SSE 远端连接。
 * 官方 SDK 的协议协商（最新版 + 五版本向后兼容）、长任务、重连语义即生态标准，
 * 自研追平的边际成本不可接受（allowlist @modelcontextprotocol/sdk 条目 ②）。
 *
 * ## 铁律合规
 *
 *  - 本文件位于 src/adapters/mcp/**，第三方只在此出现；对外仅暴露 McpClientPort。
 *  - 手写 `McpClient`（src/mcp）完整保留为回退路径（偏好连接器在 SDK 失败时回落）。
 *  - SDK 返回形状经 `unknown` 收窄映射为本仓端口类型，**不把 SDK 类型泄漏给调用方**；
 *    `any` 全程禁用。
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { Implementation, ServerCapabilities } from '@modelcontextprotocol/sdk/types.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { McpClientPort } from '../../ports/mcp/mcpClientPort.js';
import type {
  McpCallToolResult,
  McpInitializeResult,
  McpInputSchema,
  McpPromptDescriptor,
  McpResourceContent,
  McpResourceDescriptor,
  McpToolDescriptor,
} from '../../ports/mcp/mcpProtocolTypes.js';
import { log } from '../../util/logger.js';

/** 客户端适配器选项。 */
export interface SdkMcpClientOptions {
  /** 对外上报的客户端名（协议握手用）。 */
  readonly clientName: string;
  /** 对外上报的客户端版本。 */
  readonly clientVersion: string;
  /** 每个请求的超时（毫秒；缺省由 SDK 决定，当前为 60s）。 */
  readonly timeoutMs?: number | undefined;
}

/** SDK 内容块的形状（收窄用）。 */
interface SdkTextContent {
  readonly type?: string;
  readonly text?: string;
}

/**
 * 官方 SDK MCP 客户端适配器：连接单个外部 MCP 服务器（stdio 或远端传输由调用方注入）。
 */
export class SdkMcpClientAdapter implements McpClientPort {
  /** SDK 客户端实例。 */
  private readonly client: Client;
  /** 请求超时（毫秒）；undefined 交由 SDK 缺省。 */
  private readonly timeoutMs: number | undefined;
  /** 握手结果（connect 成功后可读；未握手为 undefined）。 */
  private handshake: McpInitializeResult | undefined;
  /** 是否已关闭（关闭后拒绝新请求）。 */
  private closed = false;

  private constructor(
    client: Client,
    options: SdkMcpClientOptions,
    negotiatedVersion: { version?: string },
  ) {
    this.client = client;
    this.timeoutMs = options.timeoutMs;
    const serverInfo = client.getServerVersion();
    const capabilities = client.getServerCapabilities();
    const version = negotiatedVersion.version;
    this.handshake = {
      protocolVersion: version ?? '',
      capabilities: SdkMcpClientAdapter.capabilitiesOf(capabilities),
      serverInfo: SdkMcpClientAdapter.serverInfoOf(serverInfo),
    };
  }

  /**
   * 建立连接：创建 SDK 客户端 → 挂传输 → 完成协议握手。
   *
   * @param transport SDK 传输（stdio / Streamable HTTP / SSE 由连接器决定）。
   * @param options 客户端选项。
   * @returns 已握手的客户端适配器。
   */
  public static async connect(
    transport: Transport,
    options: SdkMcpClientOptions,
  ): Promise<SdkMcpClientAdapter> {
    const negotiated: { version?: string } = {};
    const original = transport.setProtocolVersion?.bind(transport);
    // SDK 在收到 initialize 响应时会调用 transport.setProtocolVersion(协商版本)；
    // 在此处旁路记录，供 initialize() 返回真实协商版本（而不是编一个）。
    transport.setProtocolVersion = (version: string) => {
      negotiated.version = version;
      original?.(version);
    };
    const client = new Client(
      { name: options.clientName, version: options.clientVersion },
      { capabilities: {} },
    );
    await client.connect(transport);
    return new SdkMcpClientAdapter(client, options, negotiated);
  }

  /**
   * 握手结果（connect 内已完成，此处直接返回缓存）。
   *
   * @returns initialize 结果。
   */
  public async initialize(): Promise<McpInitializeResult> {
    if (this.handshake === undefined) {
      throw new Error('SDK MCP 客户端尚未握手');
    }
    return this.handshake;
  }

  /**
   * 列举远端工具。
   *
   * @returns 工具描述列表（缺失字段按协议缺省收敛，绝不向调用方漏 undefined 形状）。
   */
  public async listTools(): Promise<readonly McpToolDescriptor[]> {
    const result = (await this.request(() =>
      this.client.listTools(undefined, this.requestOptions()),
    )) as {
      readonly tools?: readonly unknown[];
    };
    const tools = result.tools ?? [];
    return tools.map((entry) => SdkMcpClientAdapter.toolOf(entry));
  }

  /**
   * 调用远端工具。
   *
   * @param name 远端工具名。
   * @param args 工具实参。
   * @returns 调用结果（isError=true 表示远端工具自身报告失败）。
   */
  public async callTool(name: string, args: Record<string, unknown>): Promise<McpCallToolResult> {
    const result = (await this.request(() =>
      this.client.callTool({ name, arguments: args }, undefined, this.requestOptions()),
    )) as { readonly content?: readonly unknown[]; readonly isError?: unknown };
    const content = (result.content ?? []).map((entry) => SdkMcpClientAdapter.textContentOf(entry));
    return { content, isError: result.isError === true };
  }

  /**
   * 列举远端资源。
   *
   * @returns 资源描述列表。
   */
  public async listResources(): Promise<readonly McpResourceDescriptor[]> {
    const result = (await this.request(() =>
      this.client.listResources(undefined, this.requestOptions()),
    )) as { readonly resources?: readonly unknown[] };
    return (result.resources ?? []).map((entry) => SdkMcpClientAdapter.resourceOf(entry));
  }

  /**
   * 读取远端资源（SDK 返回 contents 数组，本端口收敛为首条内容）。
   *
   * @param uri 资源 URI。
   * @returns 资源内容（contents 为空时 text 为空串、uri 原样带回）。
   */
  public async readResource(uri: string): Promise<McpResourceContent> {
    const result = (await this.request(() =>
      this.client.readResource({ uri }, this.requestOptions()),
    )) as { readonly contents?: readonly unknown[] };
    const first = result.contents?.[0];
    if (first === undefined) {
      return { uri, text: '' };
    }
    const record = first as { readonly uri?: unknown; readonly mimeType?: unknown };
    return {
      uri: typeof record.uri === 'string' ? record.uri : uri,
      ...(typeof record.mimeType === 'string' ? { mimeType: record.mimeType } : {}),
      text: SdkMcpClientAdapter.textContentOf(first).text,
    };
  }

  /**
   * 列举远端提示模板。
   *
   * @returns 提示模板描述列表。
   */
  public async listPrompts(): Promise<readonly McpPromptDescriptor[]> {
    const result = (await this.request(() =>
      this.client.listPrompts(undefined, this.requestOptions()),
    )) as { readonly prompts?: readonly unknown[] };
    return (result.prompts ?? []).map((entry) => SdkMcpClientAdapter.promptOf(entry));
  }

  /**
   * 获取远端提示模板（取首条消息的文本）。
   *
   * @param name 模板名。
   * @param args 模板实参。
   * @returns 文本内容（缺失为空串）。
   */
  public async getPrompt(name: string, args: Record<string, unknown> = {}): Promise<string> {
    // SDK 的 prompt arguments 契约是 string → string；非字符串值按协议丢弃（不静默转型）。
    const stringArgs: Record<string, string> = {};
    for (const [key, value] of Object.entries(args)) {
      if (typeof value === 'string') {
        stringArgs[key] = value;
      }
    }
    const result = (await this.request(() =>
      this.client.getPrompt({ name, arguments: stringArgs }, this.requestOptions()),
    )) as { readonly messages?: readonly unknown[] };
    const first = result.messages?.[0];
    if (first === undefined) {
      return '';
    }
    const content = (first as { readonly content?: unknown }).content;
    if (typeof content !== 'object' || content === null) {
      return '';
    }
    return SdkMcpClientAdapter.textContentOf(content).text;
  }

  /**
   * 心跳检测。
   *
   * @returns 服务端可响应为 true（任何失败一律收敛为 false，不抛错）。
   */
  public async ping(): Promise<boolean> {
    try {
      await this.client.ping(this.requestOptions());
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 关闭连接（幂等；SDK close 返回 Promise，此处按端口契约同步收尾）。
   *
   * @param reason 拒绝原因（保留参数语义与手写实现对齐；SDK 不需要显式 reason）。
   * @returns 无返回值。
   */
  public close(reason = 'MCP 连接已关闭'): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    void this.client.close().catch(() => log.debug('mcp.sdk.close', { reason }));
  }

  /**
   * 统一请求封装：超时注入 + 收口错误。
   *
   * @param call SDK 调用。
   * @returns SDK 原始结果。
   */
  private async request<T>(call: () => Promise<T>): Promise<T> {
    if (this.closed) {
      throw new Error('MCP 客户端已关闭');
    }
    return await call();
  }

  /**
   * 构造 SDK RequestOptions（超时）。
   *
   * @returns 请求选项；未配置超时为 undefined。
   */
  private requestOptions(): { readonly timeout: number } | undefined {
    return this.timeoutMs === undefined ? undefined : { timeout: this.timeoutMs };
  }

  /**
   * SDK ServerCapabilities → 本仓能力声明（未声明的字段一律收口为缺失）。
   *
   * @param capabilities SDK 能力（可能为 undefined）。
   * @returns 本仓能力声明。
   */
  private static capabilitiesOf(capabilities: ServerCapabilities | undefined): {
    tools?: Record<string, never>;
    resources?: Record<string, never>;
    prompts?: Record<string, never>;
  } {
    const result: {
      tools?: Record<string, never>;
      resources?: Record<string, never>;
      prompts?: Record<string, never>;
    } = {};
    if (capabilities?.tools !== undefined) {
      result.tools = {};
    }
    if (capabilities?.resources !== undefined) {
      result.resources = {};
    }
    if (capabilities?.prompts !== undefined) {
      result.prompts = {};
    }
    return result;
  }

  /**
   * SDK Implementation → 本仓 serverInfo。
   *
   * @param implementation SDK 服务端信息（可能为 undefined）。
   * @returns 本仓 serverInfo（缺失字段收敛为空串）。
   */
  private static serverInfoOf(implementation: Implementation | undefined): {
    readonly name: string;
    readonly version: string;
  } {
    return {
      name: typeof implementation?.name === 'string' ? implementation.name : '',
      version: typeof implementation?.version === 'string' ? implementation.version : '',
    };
  }

  /**
   * SDK 工具描述 → 本仓工具描述（缺失 description 收敛为空串）。
   *
   * @param entry SDK 工具描述（未知形状）。
   * @returns 本仓工具描述。
   */
  private static toolOf(entry: unknown): McpToolDescriptor {
    const record = entry as {
      readonly name?: unknown;
      readonly description?: unknown;
      readonly inputSchema?: unknown;
    };
    const schema = record.inputSchema as
      | {
          readonly type?: unknown;
          readonly properties?: unknown;
          readonly required?: unknown;
        }
      | undefined;
    const inputSchema: McpInputSchema = {
      type: 'object',
      properties:
        typeof schema?.properties === 'object' && schema.properties !== null
          ? (schema.properties as Record<string, unknown>)
          : {},
      ...(Array.isArray(schema?.required)
        ? { required: schema.required as readonly string[] }
        : {}),
    };
    return {
      name: typeof record.name === 'string' ? record.name : '',
      description: typeof record.description === 'string' ? record.description : '',
      inputSchema,
    };
  }

  /**
   * SDK 资源描述 → 本仓资源描述。
   *
   * @param entry SDK 资源描述（未知形状）。
   * @returns 本仓资源描述。
   */
  private static resourceOf(entry: unknown): McpResourceDescriptor {
    const record = entry as {
      readonly uri?: unknown;
      readonly name?: unknown;
      readonly description?: unknown;
      readonly mimeType?: unknown;
    };
    return {
      uri: typeof record.uri === 'string' ? record.uri : '',
      name: typeof record.name === 'string' ? record.name : '',
      ...(typeof record.description === 'string' ? { description: record.description } : {}),
      ...(typeof record.mimeType === 'string' ? { mimeType: record.mimeType } : {}),
    };
  }

  /**
   * SDK 提示模板描述 → 本仓提示模板描述。
   *
   * @param entry SDK 提示模板描述（未知形状）。
   * @returns 本仓提示模板描述。
   */
  private static promptOf(entry: unknown): McpPromptDescriptor {
    const record = entry as {
      readonly name?: unknown;
      readonly description?: unknown;
      readonly arguments?: readonly unknown[];
    };
    return {
      name: typeof record.name === 'string' ? record.name : '',
      ...(typeof record.description === 'string' ? { description: record.description } : {}),
      arguments: (record.arguments ?? []).map((argument) => {
        const item = argument as {
          readonly name?: unknown;
          readonly description?: unknown;
          readonly required?: unknown;
        };
        return {
          name: typeof item.name === 'string' ? item.name : '',
          ...(typeof item.description === 'string' ? { description: item.description } : {}),
          required: item.required === true,
        };
      }),
    };
  }

  /**
   * SDK 内容块 → 本仓文本内容块（非文本块收敛为空文本，绝不丢弃整个结果）。
   *
   * @param entry SDK 内容块（未知形状）。
   * @returns 本仓文本内容块。
   */
  private static textContentOf(entry: unknown): { readonly type: 'text'; readonly text: string } {
    const record = entry as SdkTextContent;
    return { type: 'text', text: typeof record.text === 'string' ? record.text : '' };
  }
}
