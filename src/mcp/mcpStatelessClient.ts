import { jsonRpc, type RpcMessage, type RpcResponse } from '../server/core/jsonRpc.ts';
import type { Transport } from '../server/transport/lineTransport.ts';
import { PendingRequests } from '../util/concurrency/pendingRequests.ts';
import { McpProtocol } from './mcpProtocol.ts';
import type { McpClientPort } from '../ports/mcp/mcpClientPort.ts';
import type {
  McpCallToolResult,
  McpInitializeResult,
  McpPromptDescriptor,
  McpResourceContent,
  McpResourceDescriptor,
  McpToolDescriptor,
} from '../ports/mcp/mcpProtocolTypes.ts';

/** v2 客户端选项。 */
export interface McpStatelessClientOptions {
  readonly transport: Transport;
  readonly timeoutMs?: number | undefined;
  readonly clientName?: string | undefined;
  readonly clientVersion?: string | undefined;
}

/**
 * MCP 2026-07-28 无状态客户端（INT-02）。
 *
 * 与 `McpClient` 的差别：不发送 `initialize` 握手；每个请求都在 `_meta` 里带协议版本与
 * 客户端能力；用 `server/discover` 做版本/能力发现。这样新规范 server 可被直接消费，
 * 旧 server 仍走 `McpClient`（双栈由连接器按 env 选择，不破坏既有路径）。
 */
export class McpStatelessClient implements McpClientPort {
  /** 请求 id → 等待中的响应处理器。 */
  private readonly pending = new PendingRequests<number, RpcResponse>();
  /** 下一个 JSON-RPC id。 */
  private nextId = 1;
  /** 是否已关闭（关闭后拒绝新请求）。 */
  private closed = false;

  /**
   * @param options 传输与客户端元信息。
   */
  public constructor(private readonly options: McpStatelessClientOptions) {
    options.transport.onMessage((message) => this.handle(message));
  }

  /**
   * 关闭客户端并失败所有在途请求。
   * @param reason 关闭原因。
   * @returns 无返回值。
   */
  public close(reason = 'MCP v2 连接已关闭'): void {
    this.closed = true;
    this.pending.failAll(new Error(reason));
  }

  /**
   * 通过 `server/discover` 发现协议版本与能力（无 initialize 握手）。
   * @returns 初始化结果。
   */
  public async initialize(): Promise<McpInitializeResult> {
    const discovered = (await this.request(McpProtocol.METHOD_SERVER_DISCOVER, {})) as {
      protocolVersion?: string;
      supportedVersions?: readonly string[];
      capabilities?: McpInitializeResult['capabilities'];
      serverInfo?: McpInitializeResult['serverInfo'];
    };
    return {
      protocolVersion: discovered.protocolVersion ?? McpProtocol.PROTOCOL_VERSION_V2,
      capabilities: discovered.capabilities ?? { tools: {}, resources: {}, prompts: {} },
      serverInfo: discovered.serverInfo ?? { name: 'unknown', version: 'unknown' },
    };
  }

  /**
   * 列出工具。
   * @returns 工具描述。
   */
  public async listTools(): Promise<readonly McpToolDescriptor[]> {
    const result = (await this.request(McpProtocol.METHOD_TOOLS_LIST, {})) as {
      tools?: readonly McpToolDescriptor[];
    };
    return result.tools ?? [];
  }

  /**
   * 调用工具。
   * @param name 工具名。
   * @param args 工具参数。
   * @returns 调用结果。
   */
  public async callTool(name: string, args: Record<string, unknown>): Promise<McpCallToolResult> {
    const result = (await this.request(McpProtocol.METHOD_TOOLS_CALL, {
      name,
      arguments: args,
    })) as McpCallToolResult & { resultType?: string };
    return {
      content: result.content ?? [],
      isError: result.isError === true,
      ...(result.structuredContent !== undefined
        ? { structuredContent: result.structuredContent }
        : {}),
    };
  }

  /**
   * 列出资源。
   * @returns 资源描述。
   */
  public async listResources(): Promise<readonly McpResourceDescriptor[]> {
    const result = (await this.request(McpProtocol.METHOD_RESOURCES_LIST, {})) as {
      resources?: readonly McpResourceDescriptor[];
    };
    return result.resources ?? [];
  }

  /**
   * 读取资源。
   * @param uri 资源 URI。
   * @returns 资源内容。
   */
  public async readResource(uri: string): Promise<McpResourceContent> {
    return (await this.request(McpProtocol.METHOD_RESOURCES_READ, { uri })) as McpResourceContent;
  }

  /**
   * 列出提示模板。
   * @returns 提示描述。
   */
  public async listPrompts(): Promise<readonly McpPromptDescriptor[]> {
    const result = (await this.request(McpProtocol.METHOD_PROMPTS_LIST, {})) as {
      prompts?: readonly McpPromptDescriptor[];
    };
    return result.prompts ?? [];
  }

  /**
   * 取提示模板并返回首条文本。
   * @param name 提示名。
   * @param args 模板参数。
   * @returns 渲染文本。
   */
  public async getPrompt(name: string, args: Record<string, unknown> = {}): Promise<string> {
    const result = (await this.request(McpProtocol.METHOD_PROMPTS_GET, {
      name,
      arguments: args,
    })) as { messages?: readonly { content?: { text?: string } }[] };
    return result.messages?.[0]?.content?.text ?? '';
  }

  /**
   * 探活（用 `server/discover`）。
   * @returns 可用时为 true。
   */
  public async ping(): Promise<boolean> {
    try {
      await this.request(McpProtocol.METHOD_SERVER_DISCOVER, {});
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 发送 v2 请求：params 自动带 `_meta`（协议版本 + 客户端信息 + 能力）。
   * @param method 方法名。
   * @param params 业务参数。
   * @returns 响应 result。
   */
  private async request(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (this.closed) throw new Error('MCP v2 客户端已关闭');
    const requestId = this.nextId;
    this.nextId += 1;
    const response = await new Promise<RpcResponse>((resolve, reject) => {
      this.pending.register(
        requestId,
        { resolve, reject },
        {
          ms: this.options.timeoutMs ?? 10_000,
          onTimeout: (handlers) => handlers.reject?.(new Error(`MCP v2 请求超时: ${method}`)),
        },
      );
      this.options.transport.send({
        jsonrpc: '2.0',
        id: requestId,
        method,
        params: {
          ...params,
          _meta: {
            'io.modelcontextprotocol/protocolVersion': McpProtocol.PROTOCOL_VERSION_V2,
            'io.modelcontextprotocol/clientInfo': {
              name: this.options.clientName ?? 'omniharness',
              version: this.options.clientVersion ?? '0.2.0',
            },
            'io.modelcontextprotocol/clientCapabilities': {
              tools: {},
              resources: {},
              prompts: {},
            },
          },
        },
      } satisfies RpcMessage);
    });
    if (response.error !== undefined) {
      throw new Error(`MCP v2 错误 ${response.error.code}: ${response.error.message}`);
    }
    return response.result;
  }

  /**
   * 处理入站消息（响应按 id 关联，通知忽略）。
   * @param message 入站 JSON-RPC 消息。
   * @returns 无返回值。
   */
  private handle(message: RpcMessage): void {
    if (jsonRpc.isRequest(message)) return;
    if (!('id' in message)) return;
    const handler = this.pending.take(Number(message.id));
    if (handler !== undefined) handler.resolve(message as RpcResponse);
  }
}
