import {
  jsonRpc,
  type RpcMessage,
  type RpcNotification,
  type RpcResponse,
} from '../server/core/jsonRpc.ts';
import type { Transport } from '../server/transport/lineTransport.ts';
import { PendingRequests } from '../util/concurrency/pendingRequests.ts';
import { Logger } from '../util/logger.ts';
import { McpProtocol } from './mcpProtocol.ts';
import { McpTraceContext, type McpTraceCarrier } from './mcpTraceContext.ts';
import type { McpClientPort } from '../ports/mcp/mcpClientPort.ts';
import type { McpInputHandler, McpInputRequest } from '../ports/mcp/mcpInputHandler.ts';
import type {
  McpCallToolResult,
  McpClientCapabilities,
  McpInitializeResult,
  McpInputResponses,
  McpPromptDescriptor,
  McpResourceContent,
  McpResourceDescriptor,
  McpSubscriptionFilter,
  McpToolDescriptor,
} from '../ports/mcp/mcpProtocolTypes.ts';

/** v2 客户端选项。 */
export interface McpStatelessClientOptions {
  readonly transport: Transport;
  readonly timeoutMs?: number | undefined;
  readonly clientName?: string | undefined;
  readonly clientVersion?: string | undefined;
  /** 每请求声明的客户端能力（缺省：注入 inputHandler 时声明 elicitation，否则空对象）。 */
  readonly clientCapabilities?: McpClientCapabilities | undefined;
  /** MRTR 输入回路（缺省 fail-closed：server 要求输入时直接报错）。 */
  readonly inputHandler?: McpInputHandler | undefined;
  /** trace 载体（对象固定使用，函数每次请求求值；缺省取当前上下文/既有 trace id）。 */
  readonly trace?: McpTraceCarrier | (() => McpTraceCarrier | undefined) | undefined;
  /** 是否在 `_meta` 中注入 trace 上下文（默认 true）。 */
  readonly tracePropagation?: boolean | undefined;
}

/** 订阅回调。 */
export interface McpSubscriptionHandlers {
  /** 收到该订阅的通知（ack 之后的业务通知）。 */
  readonly onNotification?: ((notification: RpcNotification) => void) | undefined;
  /** 服务端优雅关闭订阅（收到完成响应）。 */
  readonly onClose?: ((result: unknown) => void) | undefined;
}

/** 已建立的订阅句柄。 */
export interface McpSubscription {
  /** subscriptionId（listen 请求的 JSON-RPC id）。 */
  readonly id: number | string;
  /** 服务端 ack 的过滤条件（可能比请求的少）。 */
  readonly acknowledged: McpSubscriptionFilter;
  /**
   * 结束订阅（发 `notifications/cancelled`）。
   * @returns 无返回值。
   */
  close(): void;
}

/** 在途订阅（ack 前的 Promise 与定时器）。 */
interface PendingSubscription {
  /** ack 兑现器。 */
  readonly resolve: (filter: McpSubscriptionFilter) => void;
  /** ack 失败器。 */
  readonly reject: (error: Error) => void;
  /** ack 超时定时器。 */
  readonly timer: ReturnType<typeof setTimeout>;
  /** 订阅回调。 */
  readonly handlers: McpSubscriptionHandlers;
  /** 是否已结束。 */
  closed: boolean;
}

/**
 * 把宿主回答映射为线缆形状（id → value）。
 * @param responses 宿主回答列表。
 * @returns 回答映射。
 */
const responsesMapOf = (
  responses: readonly { readonly id: string; readonly value: unknown }[],
): McpInputResponses => {
  const out: Record<string, unknown> = {};
  for (const response of responses) {
    const value = response.value;
    out[response.id] =
      typeof value === 'object' &&
      value !== null &&
      typeof (value as { readonly action?: unknown }).action === 'string'
        ? value
        : { action: 'accept', content: { answer: value } };
  }
  return out;
};

/**
 * MCP 2026-07-28 无状态客户端。
 *
 * 与 `McpClient` 的差别：不发送 `initialize` 握手；每个请求都在 `_meta` 里带协议版本、客户端能力、
 * 客户端信息与 OTel trace 上下文；用 `server/discover` 做版本/能力发现；支持 MRTR（`input_required`
 * → `inputResponses` 重试，原样回传 `requestState`）与 `subscriptions/listen` 长生命周期订阅。
 * 旧 server 仍走 `McpClient`（双栈由连接器按 env 选择，不破坏既有路径）。
 */
export class McpStatelessClient implements McpClientPort {
  /** 请求 id → 等待中的响应处理器（普通请求）。 */
  private readonly pending = new PendingRequests<number, RpcResponse>();
  /** subscriptionId → 在途订阅。 */
  private readonly subscriptions = new Map<string, PendingSubscription>();
  /** 下一个 JSON-RPC id（普通请求与订阅共用，保证不重复）。 */
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
   * 关闭客户端并失败所有在途请求/订阅。
   * @param reason 关闭原因。
   * @returns 无返回值。
   */
  public close(reason = 'MCP v2 连接已关闭'): void {
    this.closed = true;
    this.pending.failAll(new Error(reason));
    for (const [key, subscription] of this.subscriptions) {
      this.subscriptions.delete(key);
      clearTimeout(subscription.timer);
      if (!subscription.closed) {
        subscription.closed = true;
        subscription.reject(new Error(reason));
      }
    }
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
      resultType?: string;
      _meta?: Record<string, unknown>;
    };
    const supported = discovered.supportedVersions ?? [];
    const metaInfo = discovered._meta?.[McpProtocol.META_SERVER_INFO] as
      McpInitializeResult['serverInfo'] | undefined;
    return {
      protocolVersion:
        discovered.protocolVersion ??
        (supported.includes(McpProtocol.PROTOCOL_VERSION_V2)
          ? McpProtocol.PROTOCOL_VERSION_V2
          : (supported[0] ?? McpProtocol.PROTOCOL_VERSION_V2)),
      capabilities: discovered.capabilities ?? { tools: {}, resources: {}, prompts: {} },
      serverInfo: discovered.serverInfo ?? metaInfo ?? { name: 'unknown', version: 'unknown' },
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
   * 调用工具（MRTR：`input_required` → 宿主回答 → 带 `inputResponses` + `requestState` 重试）。
   * @param name 工具名。
   * @param args 工具参数。
   * @returns 调用结果。
   */
  public async callTool(name: string, args: Record<string, unknown>): Promise<McpCallToolResult> {
    let result = (await this.request(McpProtocol.METHOD_TOOLS_CALL, {
      name,
      arguments: args,
    })) as McpCallToolResult & {
      resultType?: string;
      inputRequests?: unknown;
      requestState?: string;
    };
    for (let round = 0; round < 3 && result.resultType === 'input_required'; round += 1) {
      const requests = McpStatelessClient.inputRequestsOf(result.inputRequests);
      if (requests.length === 0 && result.requestState === undefined) {
        throw new Error(
          'MCP_INPUT_REQUIRED: resultType=input_required 但没有 inputRequests/requestState',
        );
      }
      const responses = await this.answersOf(requests);
      const retry: Record<string, unknown> = {
        name,
        arguments: args,
        ...(responses !== undefined ? { inputResponses: responses } : {}),
        ...(result.requestState !== undefined ? { requestState: result.requestState } : {}),
      };
      result = (await this.request(McpProtocol.METHOD_TOOLS_CALL, retry)) as McpCallToolResult & {
        resultType?: string;
        inputRequests?: unknown;
        requestState?: string;
      };
    }
    if (result.resultType === 'input_required') {
      throw new Error('MCP_INPUT_REQUIRED: MRTR 重试 3 轮后 server 仍要求输入');
    }
    return {
      content: result.content ?? [],
      isError: result.isError === true,
      ...(result.structuredContent !== undefined
        ? { structuredContent: result.structuredContent }
        : {}),
    };
  }

  /**
   * 把输入请求交给宿主回答器并构造线缆形状的回答映射。
   * @param requests 输入请求列表。
   * @returns 回答映射；请求为空且无 state 时为 undefined。
   */
  private async answersOf(
    requests: readonly McpInputRequest[],
  ): Promise<McpInputResponses | undefined> {
    if (requests.length === 0) return undefined;
    const handler = this.options.inputHandler;
    if (handler === undefined) {
      throw new Error(
        'MCP_INPUT_REQUIRED: server 要求补充输入（MRTR），但客户端未配置 inputHandler；' +
          '请在宿主侧注入回答器（无 UI 时 fail-closed，不自动猜测）',
      );
    }
    const responses = await handler.resolve(requests);
    const answered = new Set(responses.map((response) => response.id));
    const missing = requests.filter((request) => !answered.has(request.id));
    if (missing.length > 0) {
      throw new Error(
        `MCP_INPUT_REQUIRED: 输入回路缺少回答：${missing.map((request) => request.id).join(', ')}`,
      );
    }
    return responsesMapOf(responses);
  }

  /**
   * 把 server 的 `inputRequests` 收敛为带 id 的请求列表（兼容对象映射与旧数组形态）。
   * @param raw 原始值。
   * @returns 请求列表。
   */
  private static inputRequestsOf(raw: unknown): readonly McpInputRequest[] {
    if (Array.isArray(raw)) {
      return raw.map((entry, index) => McpStatelessClient.inputRequestOf(String(index), entry));
    }
    if (typeof raw !== 'object' || raw === null) return [];
    return Object.entries(raw as Record<string, unknown>).map(([id, entry]) =>
      McpStatelessClient.inputRequestOf(id, entry),
    );
  }

  /**
   * 单条输入请求 → 客户端视图。
   * @param fallbackId 映射键/序号。
   * @param entry 原始请求对象。
   * @returns 输入请求。
   */
  private static inputRequestOf(fallbackId: string, entry: unknown): McpInputRequest {
    const record =
      typeof entry === 'object' && entry !== null ? (entry as Record<string, unknown>) : {};
    const params =
      typeof record['params'] === 'object' && record['params'] !== null
        ? (record['params'] as Record<string, unknown>)
        : record;
    const idCandidate = record['id'] ?? record['requestId'] ?? record['key'] ?? fallbackId;
    const id =
      typeof idCandidate === 'string' && idCandidate !== '' ? idCandidate : String(fallbackId);
    const promptCandidate = params['prompt'] ?? params['message'] ?? params['description'];
    return {
      id,
      ...(typeof promptCandidate === 'string' && promptCandidate !== ''
        ? { prompt: promptCandidate }
        : {}),
      raw: entry,
    };
  }

  /**
   * 打开 `subscriptions/listen` 长生命周期订阅。
   * @param filter 订阅的过滤条件。
   * @param handlers 通知/关闭回调（可选）。
   * @returns 已 ack 的订阅句柄（ack 超时/连接关闭时 reject）。
   */
  public async listen(
    filter: McpSubscriptionFilter,
    handlers: McpSubscriptionHandlers = {},
  ): Promise<McpSubscription> {
    if (this.closed) throw new Error('MCP v2 客户端已关闭');
    const id = this.nextId;
    this.nextId += 1;
    const key = McpStatelessClient.keyOf(id);
    const ack = new Promise<McpSubscriptionFilter>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.subscriptions.delete(key);
        reject(new Error(`MCP v2 订阅 ack 超时: ${String(id)}`));
      }, this.options.timeoutMs ?? 10_000);
      timer.unref?.();
      this.subscriptions.set(key, {
        resolve,
        reject,
        timer,
        handlers,
        closed: false,
      });
    });
    this.options.transport.send({
      jsonrpc: '2.0',
      id,
      method: McpProtocol.METHOD_SUBSCRIPTIONS_LISTEN,
      params: {
        notifications: { ...filter },
        _meta: this.metaOf(),
      },
    } satisfies RpcMessage);
    const acknowledged = await ack;
    return {
      id,
      acknowledged,
      close: () => this.closeSubscription(id),
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
   * 读取资源（把规范 `{contents:[…]}` 归一为仓库的 `McpResourceContent`）。
   * @param uri 资源 URI。
   * @returns 资源内容。
   */
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
   * 关闭一条订阅（发 `notifications/cancelled`）。
   * @param id subscriptionId。
   * @returns 无返回值。
   */
  private closeSubscription(id: number | string): void {
    const key = McpStatelessClient.keyOf(id);
    const subscription = this.subscriptions.get(key);
    if (subscription !== undefined) {
      this.subscriptions.delete(key);
      clearTimeout(subscription.timer);
      subscription.closed = true;
    }
    this.options.transport.send(
      jsonRpc.notify(McpProtocol.NOTIFICATION_CANCELLED, { requestId: id }),
    );
  }

  /**
   * 发送 v2 请求：params 自动带 `_meta`（协议版本 + 客户端信息 + 能力 + trace）。
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
        params: { ...params, _meta: this.metaOf() },
      } satisfies RpcMessage);
    });
    if (response.error !== undefined) {
      throw new Error(`MCP v2 错误 ${response.error.code}: ${response.error.message}`);
    }
    return response.result;
  }

  /**
   * 构造每请求 `_meta`（协议版本、客户端信息、能力、trace）。
   * @returns `_meta` 对象。
   */
  private metaOf(): Record<string, unknown> {
    const meta: Record<string, unknown> = {
      [McpProtocol.META_PROTOCOL_VERSION]: McpProtocol.PROTOCOL_VERSION_V2,
      [McpProtocol.META_CLIENT_INFO]: {
        name: this.options.clientName ?? 'omniharness',
        version: this.options.clientVersion ?? '0.2.0',
      },
      [McpProtocol.META_CLIENT_CAPABILITIES]: this.capabilitiesOf(),
    };
    const carrier = this.traceOf();
    return carrier === undefined ? meta : McpTraceContext.inject(meta, carrier);
  }

  /**
   * 客户端能力（显式配置优先；否则有 inputHandler 时声明 elicitation）。
   * @returns 能力声明。
   */
  private capabilitiesOf(): McpClientCapabilities {
    if (this.options.clientCapabilities !== undefined) return this.options.clientCapabilities;
    return this.options.inputHandler === undefined ? {} : { elicitation: {} };
  }

  /**
   * 取本次请求的 trace 载体。
   * @returns 载体；显式关闭传播时为 undefined。
   */
  private traceOf(): McpTraceCarrier | undefined {
    if (this.options.tracePropagation === false) return undefined;
    const configured = this.options.trace;
    if (typeof configured === 'function') return configured();
    if (configured !== undefined) return configured;
    const current = McpTraceContext.current();
    if (current !== undefined) return current;
    const existing = Logger.currentTrace();
    return existing === undefined ? McpTraceContext.root() : McpTraceContext.fromTraceId(existing);
  }

  /**
   * 处理入站消息（响应按 id 关联；订阅通知按 subscriptionId 关联）。
   * @param message 入站 JSON-RPC 消息。
   * @returns 无返回值。
   */
  private handle(message: RpcMessage): void {
    if (jsonRpc.isRequest(message)) return;
    if (!('id' in message)) {
      this.handleNotification(message as RpcNotification);
      return;
    }
    const key = McpStatelessClient.keyOf(message.id);
    const subscription = this.subscriptions.get(key);
    if (subscription !== undefined) {
      this.subscriptions.delete(key);
      clearTimeout(subscription.timer);
      subscription.closed = true;
      subscription.handlers.onClose?.((message as RpcResponse).result);
      return;
    }
    const handler = this.pending.take(Number(message.id));
    if (handler !== undefined) handler.resolve(message as RpcResponse);
  }

  /**
   * 处理通知：ack 兑现订阅，其余按 subscriptionId 回调。
   * @param message 通知。
   * @returns 无返回值。
   */
  private handleNotification(message: RpcNotification): void {
    const params = message.params ?? {};
    const meta = params['_meta'];
    const subscriptionId =
      typeof meta === 'object' && meta !== null
        ? (meta as Record<string, unknown>)[McpProtocol.META_SUBSCRIPTION_ID]
        : undefined;
    if (typeof subscriptionId !== 'number' && typeof subscriptionId !== 'string') return;
    const subscription = this.subscriptions.get(McpStatelessClient.keyOf(subscriptionId));
    if (subscription === undefined) return;
    if (message.method === McpProtocol.NOTIFICATION_SUBSCRIPTIONS_ACKNOWLEDGED) {
      clearTimeout(subscription.timer);
      const filter = params['notifications'];
      subscription.resolve(
        typeof filter === 'object' && filter !== null ? (filter as McpSubscriptionFilter) : {},
      );
      return;
    }
    subscription.handlers.onNotification?.(message);
  }

  /**
   * Map 键（数字/字符串 id 不混淆）。
   * @param id 请求 id。
   * @returns Map 键。
   */
  private static keyOf(id: number | string): string {
    return `${typeof id}:${String(id)}`;
  }
}
