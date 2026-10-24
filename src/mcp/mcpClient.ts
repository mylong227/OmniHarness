import { jsonRpc, type RpcMessage, type RpcResponse } from '../server/core/jsonRpc.ts';
import type { Transport } from '../server/transport/lineTransport.ts';
import { McpProtocol } from './mcpProtocol.ts';
import { McpContentBlocks } from './mcpContentBlocks.ts';
import type {
  McpCallToolResult,
  McpInitializeResult,
  McpPromptDescriptor,
  McpResourceContent,
  McpResourceDescriptor,
  McpToolDescriptor,
} from '../ports/mcp/mcpProtocolTypes.ts';
import type { McpClientPort } from '../ports/mcp/mcpClientPort.ts';
import { log } from '../util/logger.ts';
import { PendingRequests } from '../util/concurrency/pendingRequests.ts';

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
 *
 * 2026-10-02 起实现 ports 层 {@link McpClientPort}（客户端方向迁官方 SDK 的前置）：
 * 本类从「网关直接吃的具体类」降级为**手写回退实现**，方法面与语义不变。
 */
export class McpClient implements McpClientPort {
  private readonly pending = new PendingRequests<number, RpcResponse>();
  private nextId = 1;
  /** 是否已关闭（关闭后拒绝新请求，并立即拒绝全部在途请求）。 */
  private closed = false;
  /** 工具列表变化监听（可缺省；`notifications/tools/list_changed` 到达时触发）。 */
  private toolsChanged: (() => void) | undefined;

  public constructor(private readonly options: McpClientOptions) {
    options.transport.onMessage((message) => this.handle(message));
  }

  /**
   * 订阅工具列表变化通知（MCP `notifications/tools/list_changed`）。
   * @param listener 变化回调（重复注册以最后一次为准）。
   * @returns 无返回值。
   */
  public onToolsChanged(listener: () => void): void {
    this.toolsChanged = listener;
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

  /** 读取远端资源（兼容 2026-07-28 的 `{contents:[…]}` 与旧版 `{uri,text}` 形状）。 */
  public async readResource(uri: string): Promise<McpResourceContent> {
    const result = (await this.request(McpProtocol.METHOD_RESOURCES_READ, { uri })) as {
      contents?: readonly { uri?: unknown; mimeType?: unknown; text?: unknown }[];
      uri?: unknown;
      mimeType?: unknown;
      text?: unknown;
    };
    const first = result.contents?.[0];
    if (first !== undefined) {
      return {
        uri: typeof first.uri === 'string' ? first.uri : uri,
        ...(typeof first.mimeType === 'string' ? { mimeType: first.mimeType } : {}),
        text: typeof first.text === 'string' ? first.text : '',
      };
    }
    return {
      uri: typeof result.uri === 'string' ? result.uri : uri,
      ...(typeof result.mimeType === 'string' ? { mimeType: result.mimeType } : {}),
      text: typeof result.text === 'string' ? result.text : '',
    };
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

  /** 处理入站消息（响应按 id 关联；工具列表变化通知触发回调）。
   * @returns 无返回值。
   */
  private handle(message: RpcMessage): void {
    if (jsonRpc.isRequest(message)) {
      // 服务端反向请求（sampling / roots 等）本客户端未实现：显式回「方法不存在」，
      // 避免对端永久等待。此前直接 return，请求方只能等超时。
      this.options.transport.send(
        jsonRpc.errorResponse(
          message.id,
          McpProtocol.ERROR_METHOD_NOT_FOUND,
          '客户端不支持服务端发起的方法',
        ),
      );
      return;
    }
    if (!('id' in message)) {
      if ((message as { method?: string }).method === McpProtocol.NOTIFICATION_TOOLS_LIST_CHANGED) {
        this.toolsChanged?.();
      }
      return;
    }
    const handler = this.pending.take(Number(message.id));
    if (handler !== undefined) {
      handler.resolve(message);
    }
  }

  /**
   * 规整调用结果（缺失 content 视为空成功）。
   *
   * G10/T3（2026-10-03）：内容块走**共用归一化**（{@link McpContentBlocks}）——此前原样透传，而网关
   * 只读 `.text`，于是图片 / 资源链接在这条**手写回退路径**上变成**空段**（与 SDK 适配器那条路径是
   * 同一处静默丢块）；`structuredContent` 此前也被直接丢掉。
   * @param result 远端返回体（未知形状）。
   * @returns 规整后的调用结果。
   */
  private asCallResult(result: unknown): McpCallToolResult {
    const raw = result as { readonly content?: unknown; readonly isError?: unknown } | undefined;
    const structured = (result as { readonly structuredContent?: unknown } | undefined)
      ?.structuredContent;
    return {
      content: McpContentBlocks.normalizeAll(raw?.content),
      isError: raw?.isError === true,
      ...(structured !== undefined ? { structuredContent: structured } : {}),
    };
  }
}
