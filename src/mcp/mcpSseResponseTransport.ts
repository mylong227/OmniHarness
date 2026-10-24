/**
 * MCP 2026-07-28 的 SSE/Streamable HTTP **长生命周期 POST 响应流**适配器。
 *
 * Streamable HTTP 的 `subscriptions/listen` 不是「一次请求一次响应」，而是同一个 POST
 * 持续写 SSE 帧：先 ack，再通知，最后（优雅关闭时）一条 JSON-RPC 完成响应。本类把
 * {@link Transport} 的「全局 send」细化为「按原始 request id 路由到对应响应流」：
 *  - HTTP 层收到一个 POST 请求时先 `registerStream(requestId, write)`；
 *  - 服务端 `openSubscription(requestId)` 拿到绑定该流的通道；
 *  - 普通请求的响应仍走 `send()`，但会被路由回**它自己**那条 POST 响应；
 *  - 没有订阅能力的传输（stdio）不需要本类：服务端回落共享通道 + `subscriptionId`。
 *
 * 本类只产出 SSE 帧文本（`event:`/`data:`），不绑定具体 HTTP server——`write` 由宿主决定
 * 怎么写 socket，便于在现有 HTTP/SSE 能力上接线，也便于单测逐个断言帧顺序。
 */
import type { Transport } from '../ports/server/transport.ts';
import type { SubscriptionChannel } from '../ports/server/subscriptionChannel.ts';
import type { RequestId } from '../ports/server/requestId.ts';
import type { RpcMessage } from '../ports/server/rpcMessage.ts';
import { McpProtocol } from './mcpProtocol.ts';

/** 一帧 SSE（`event` 缺省为 `message`）。 */
export interface McpSseFrame {
  /** SSE 事件名（缺省 `message`）。 */
  readonly event?: string | undefined;
  /** `data:` 行的内容（JSON 文本）。 */
  readonly data: string;
}

/** SSE 写帧回调（宿主的 socket/response 写入器）。 */
export type McpSseWriter = (frame: McpSseFrame) => void;

/** 一条已登记的响应流。 */
interface ResponseStream {
  readonly write: McpSseWriter;
}

/**
 * 按 POST 请求分流的长生命周期 SSE 传输。
 */
export class McpSseResponseTransport implements Transport {
  /** 已登记的响应流（键为 JSON-RPC 请求 id）。 */
  private readonly streams = new Map<string, ResponseStream>();
  /** 入站消息回调。 */
  private callback: ((message: RpcMessage) => void) | undefined;

  /**
   * @param fallback 没有登记响应流时的写帧目标（例如单连接测试/诊断通道）。
   */
  public constructor(private readonly fallback: McpSseWriter) {}

  /**
   * 登记一条 POST 响应流（HTTP 层在投递请求前调用）。
   * @param requestId 该 POST 的请求 id。
   * @param write 该响应的写帧函数。
   * @returns 无返回值。
   */
  public registerStream(requestId: RequestId, write: McpSseWriter): void {
    this.streams.set(McpSseResponseTransport.keyOf(requestId), { write });
  }

  /**
   * 注销响应流（客户端断开/写完）。
   * @param requestId 请求 id。
   * @returns 无返回值。
   */
  public unregisterStream(requestId: RequestId): void {
    this.streams.delete(McpSseResponseTransport.keyOf(requestId));
  }

  /**
   * 发送消息：响应按 id 路由，通知按 `subscriptionId` 路由，其余走 fallback。
   * @param message RPC 消息。
   * @returns 无返回值。
   */
  public send(message: RpcMessage): void {
    const target = this.targetOf(message);
    if (target === undefined) {
      this.fallback({ event: 'message', data: JSON.stringify(message) });
      return;
    }
    this.writeTo(target, message);
    // 普通响应写完即流结束；订阅的完成响应同样由服务端随后 close() 收尾。
    if ('id' in message && !('method' in message)) {
      this.streams.delete(target);
    }
  }

  /**
   * 订阅入站消息（HTTP 层把 POST body 解析成 RPC 消息后调用）。
   * @param callback 入站回调。
   * @returns 无返回值。
   */
  public onMessage(callback: (message: RpcMessage) => void): void {
    this.callback = callback;
  }

  /**
   * 把一条已解析的请求交给服务端（HTTP 层用）。
   * @param message 入站 RPC 消息。
   * @returns 无返回值。
   */
  public deliver(message: RpcMessage): void {
    this.callback?.(message);
  }

  /**
   * 为 `subscriptions/listen` 打开绑定该 POST 的通道。
   * @param requestId 请求 id（即 subscriptionId）。
   * @returns 通道；该请求没有登记响应流时 undefined（服务端回落共享通道）。
   */
  public openSubscription(requestId: RequestId): SubscriptionChannel | undefined {
    const key = McpSseResponseTransport.keyOf(requestId);
    if (!this.streams.has(key)) return undefined;
    return {
      send: (message) => this.writeTo(key, message),
      close: () => {
        this.streams.delete(key);
      },
    };
  }

  /**
   * 当前登记的响应流数量（观测/测试用）。
   * @returns 流数量。
   */
  public streamCount(): number {
    return this.streams.size;
  }

  /**
   * 编码一帧 SSE 文本（供宿主直接写入 response）。
   * @param frame SSE 帧。
   * @returns `event: …\ndata: …\n\n`。
   */
  public static encode(frame: McpSseFrame): string {
    const event = frame.event ?? 'message';
    return `event: ${event}\ndata: ${frame.data}\n\n`;
  }

  /**
   * 计算消息应路由到的响应流键。
   * @param message RPC 消息。
   * @returns stream key；无匹配 undefined。
   */
  private targetOf(message: RpcMessage): string | undefined {
    if ('id' in message && !('method' in message)) {
      const key = McpSseResponseTransport.keyOf(message.id);
      return this.streams.has(key) ? key : undefined;
    }
    const params = (message as { readonly params?: Record<string, unknown> }).params;
    const meta = params?.['_meta'];
    if (typeof meta === 'object' && meta !== null) {
      const subscriptionId = (meta as Record<string, unknown>)[McpProtocol.META_SUBSCRIPTION_ID];
      if (typeof subscriptionId === 'number' || typeof subscriptionId === 'string') {
        const key = McpSseResponseTransport.keyOf(subscriptionId);
        if (this.streams.has(key)) return key;
      }
    }
    return undefined;
  }

  /**
   * 往指定 key 的流写一条消息。
   * @param key 响应流键。
   * @param message RPC 消息。
   * @returns 无返回值。
   */
  private writeTo(key: string, message: RpcMessage): void {
    const stream = this.streams.get(key);
    if (stream === undefined) return;
    stream.write({ event: 'message', data: JSON.stringify(message) });
  }

  /**
   * 请求 id → Map 键（数字/字符串不混淆）。
   * @param id 请求 id。
   * @returns Map 键。
   */
  private static keyOf(id: RequestId): string {
    return `${typeof id}:${String(id)}`;
  }
}
