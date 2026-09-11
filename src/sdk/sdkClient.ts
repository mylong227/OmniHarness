import { jsonRpc, type RpcMessage, type RpcResponse } from '../server/jsonRpc.js';
import type { SdkSocket } from './webSocketSdkSocket.js';

/** SDK 客户端选项。 */
export interface SdkClientOptions {
  readonly socket: SdkSocket;
  /** 请求超时（毫秒，默认 30000）。 */
  readonly timeoutMs?: number;
}

/** 等待中的请求。 */
interface PendingCall {
  readonly resolve: (response: RpcResponse) => void;
  readonly reject: (error: Error) => void;
}

/** 通知处理器集合。 */
type EventHandler = (params: Record<string, unknown>) => void;

/** SDK 客户端：请求-响应 + 服务端通知订阅（生成的 SDK 直接接这两个能力）。 */
export class SdkClient {
  private readonly pending = new Map<number, PendingCall>();
  private readonly handlers = new Map<string, Set<EventHandler>>();
  private readonly opened: Promise<void>;
  private nextId = 1;

  public constructor(private readonly options: SdkClientOptions) {
    this.opened = this.bindSocket(options.socket);
  }

  /** 连接就绪。 */
  public ready(): Promise<void> {
    return this.opened;
  }

  /** 发起 RPC 调用。 */
  public async call<T>(method: string, params: Record<string, unknown>): Promise<T> {
    await this.opened;
    const id = this.nextId;
    this.nextId += 1;
    const response = await new Promise<RpcResponse>((resolve, reject) => {
      const entry: PendingCall = { resolve, reject };
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`SDK 请求超时: ${method}`));
      }, this.options.timeoutMs ?? 30000);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          entry.resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          entry.reject(error);
        },
      });
      this.options.socket.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    });
    if (response.error !== undefined) {
      throw new Error(`RPC 错误 ${response.error.code}: ${response.error.message}`);
    }
    return response.result as T;
  }

  /** 订阅服务端通知，返回取消订阅函数。 */
  public on(event: string, handler: EventHandler): () => void {
    const handlers = this.handlers.get(event) ?? new Set<EventHandler>();
    handlers.add(handler);
    this.handlers.set(event, handlers);
    return () => {
      handlers.delete(handler);
    };
  }

  /** 关闭连接（挂起请求立即失败）。 */
  public close(): void {
    for (const [, entry] of this.pending) {
      entry.reject(new Error('SDK 连接已关闭'));
    }
    this.pending.clear();
    this.handlers.clear();
    this.options.socket.close();
  }

  /** 绑定 socket 生命周期与消息。 */
  private bindSocket(socket: SdkSocket): Promise<void> {
    const opened = new Promise<void>((resolve, reject) => {
      socket.onOpen(() => resolve());
      socket.onError((error) => reject(error));
    });
    socket.onMessage((text) => this.handleMessage(text));
    socket.onClose(() => this.rejectPending(new Error('SDK 连接已关闭')));
    return opened;
  }

  /** 处理入站消息：响应按 id 关联，通知分发给订阅者。 */
  private handleMessage(text: string): void {
    const message = jsonRpc.parse(text);
    if (message === undefined) {
      return;
    }
    if (this.isResponse(message)) {
      const entry = this.pending.get(Number(message.id));
      if (entry !== undefined) {
        this.pending.delete(Number(message.id));
        entry.resolve(message);
      }
      return;
    }
    this.dispatch(message);
  }

  /** 是否为响应（有 id 无 method）。 */
  private isResponse(message: RpcMessage): message is RpcResponse {
    return 'id' in message && !('method' in message);
  }

  /** 分发通知给订阅者。 */
  private dispatch(message: RpcMessage): void {
    if (!('method' in message)) {
      return;
    }
    const handlers = this.handlers.get(message.method);
    if (handlers === undefined) {
      return;
    }
    for (const handler of handlers) {
      handler((message.params ?? {}) as Record<string, unknown>);
    }
  }

  /** 挂起请求全部失败。 */
  private rejectPending(error: Error): void {
    for (const [, entry] of this.pending) {
      entry.reject(error);
    }
    this.pending.clear();
  }
}
