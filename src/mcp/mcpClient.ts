import { jsonRpc, type RpcMessage, type RpcResponse } from '../server/core/jsonRpc.js';
import type { Transport } from '../server/transport/lineTransport.js';
import {
  McpProtocol,
  type McpCallToolResult,
  type McpInitializeResult,
  type McpToolDescriptor,
  type McpResourceDescriptor,
  type McpResourceContent,
  type McpPromptDescriptor,
} from './mcpProtocol.js';
import { log } from '../util/logger.js';
import { PendingRequests } from '../util/pendingRequests.js';

/**
 * @beta
 * MCP 客户端选项。
 */
export interface McpClientOptions {
  readonly transport: Transport;
  /** 请求超时（毫秒，默认 10000）。 */
  readonly timeoutMs?: number | undefined;
}

/**
 * @beta
 * MCP 客户端：连接单个 MCP 服务器，握手 → 列工具 → 调工具。
 */
export class McpClient {
  private readonly pending = new PendingRequests<number, RpcResponse>();
  private nextId = 1;
  /** 是否已关闭（关闭后拒绝新请求，并立即拒绝全部在途请求）。 */
  private closed = false;

  public constructor(private readonly options: McpClientOptions) {
    options.transport.onMessage((message) => this.handle(message));
  }

  /**
   * 关闭客户端：立即拒绝全部在途请求（fail-fast），此后拒绝新请求。
   *
   * 为什么必须显式提供：`Transport` 契约只有 `onMessage` / `send`，**没有关闭通知**
   * ⇒ 传输侧结束（stdio 结束、对端进程退出）时，在途请求只能各自等超时定时器（默认 10s）才会被拒，
   * 调用方在这段时间里拿不到任何信号、表现为「卡住」。调用方在结束连接时应调用本方法。
   * 幂等：重复调用无副作用。
   * @param reason 拒绝原因（用于错误消息）。
   * @returns 无返回值。
   */
  public close(reason = 'MCP 连接已关闭'): void {
    this.closed = true;
    this.pending.failAll(new Error(reason));
  }

  /** 握手，返回服务端信息与能力。 */
  public async initialize(): Promise<McpInitializeResult> {
    const result = await this.request(McpProtocol.METHOD_INITIALIZE, {
      protocolVersion: McpProtocol.PROTOCOL_VERSION,
    });
    return result as McpInitializeResult;
  }

  /** 列举远端工具。 */
  public async listTools(): Promise<readonly McpToolDescriptor[]> {
    const result = (await this.request(McpProtocol.METHOD_TOOLS_LIST, {})) as {
      tools?: readonly McpToolDescriptor[];
    };
    return result.tools ?? [];
  }

  /** 调用远端工具。 */
  public async callTool(name: string, args: Record<string, unknown>): Promise<McpCallToolResult> {
    log.debug('mcp.call_tool', { name });
    const result = await this.request(McpProtocol.METHOD_TOOLS_CALL, { name, arguments: args });
    return this.asCallResult(result);
  }

  /** 列举远端资源。 */
  public async listResources(): Promise<readonly McpResourceDescriptor[]> {
    const result = (await this.request(McpProtocol.METHOD_RESOURCES_LIST, {})) as {
      resources?: readonly McpResourceDescriptor[];
    };
    return result.resources ?? [];
  }

  /** 读取远端资源。 */
  public async readResource(uri: string): Promise<McpResourceContent> {
    return (await this.request(McpProtocol.METHOD_RESOURCES_READ, { uri })) as McpResourceContent;
  }

  /** 列举远端提示模板。 */
  public async listPrompts(): Promise<readonly McpPromptDescriptor[]> {
    const result = (await this.request(McpProtocol.METHOD_PROMPTS_LIST, {})) as {
      prompts?: readonly McpPromptDescriptor[];
    };
    return result.prompts ?? [];
  }

  /** 获取远端提示模板。 */
  public async getPrompt(name: string, args: Record<string, unknown> = {}): Promise<string> {
    const result = (await this.request(McpProtocol.METHOD_PROMPTS_GET, {
      name,
      arguments: args,
    })) as {
      messages?: readonly { content?: { text?: string } }[];
    };
    return result.messages?.[0]?.content?.text ?? '';
  }

  /** 心跳检测。 */
  public async ping(): Promise<boolean> {
    try {
      await this.request(McpProtocol.METHOD_PING, {});
      return true;
    } catch {
      return false;
    }
  }

  /** 发送带 id 的请求并等待响应。 */
  private async request(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (this.closed) {
      throw new Error('MCP 客户端已关闭');
    }
    const requestId = this.nextId;
    this.nextId += 1;
    log.debug('mcp.request', { method, requestId });
    const response = await new Promise<RpcResponse>((resolve, reject) => {
      this.pending.register(
        requestId,
        { resolve, reject },
        {
          ms: this.options.timeoutMs ?? 10000,
          onTimeout: (handlers) => {
            log.warn('mcp.request.timeout', { method, requestId });
            handlers.reject?.(new Error(`MCP 请求超时: ${method}`));
          },
        },
      );
      this.options.transport.send({ jsonrpc: '2.0', id: requestId, method, params });
    });
    if (response.error !== undefined) {
      log.warn('mcp.response.error', {
        method,
        requestId,
        code: response.error.code,
        message: response.error.message,
      });
      throw new Error(`MCP 错误 ${response.error.code}: ${response.error.message}`);
    }
    return response.result;
  }

  /** 处理入站消息（响应按 id 关联，通知忽略）。
   * @returns 无返回值。
   */
  private handle(message: RpcMessage): void {
    if (jsonRpc.isRequest(message)) {
      return;
    }
    if (!('id' in message)) {
      return;
    }
    const handler = this.pending.take(Number(message.id));
    if (handler !== undefined) {
      handler.resolve(message);
    }
  }

  /** 规整调用结果（缺失 content 视为空成功）。 */
  private asCallResult(result: unknown): McpCallToolResult {
    const raw = result as Partial<McpCallToolResult> | undefined;
    return {
      content: raw?.content ?? [],
      isError: raw?.isError === true,
    };
  }
}
