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
  /** 等待响应的请求表：请求 id → resolve/reject（含超时清理）。 */
  private readonly pending = new Map<number, PendingCall>();
  /** 通知订阅表：事件名 → 处理器集合。 */
  private readonly handlers = new Map<string, Set<EventHandler>>();
  /** 连接就绪 Promise（构造期开始握手，socket open 后 resolve）。 */
  private readonly opened: Promise<void>;
  /** 下一个请求 id（自增，用于 JSON-RPC 响应关联）。 */
  private nextId = 1;

  /**
   * 创建 SDK 客户端并绑定 socket 生命周期与消息分发。
   * @param options 客户端选项（socket 与请求超时），同时作为参数属性持有为实例字段
   */
  public constructor(private readonly options: SdkClientOptions) {
    this.opened = this.bindSocket(options.socket);
  }

  /**
   * 连接就绪。
   * @returns socket open 后 resolve；连接出错则 reject。
   */
  public ready(): Promise<void> {
    return this.opened;
  }

  /**
   * 发起 RPC 调用。
   * @param method 服务端 RPC 方法名。
   * @param params 方法参数对象。
   * @returns 服务端 result；RPC error 或超时则抛错。
   */
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

  /**
   * 订阅服务端通知，返回取消订阅函数。
   * @param event 通知方法名（如 'memory.changed'）。
   * @param handler 通知处理器（接收通知 params）。
   * @returns 取消订阅函数（调用后该处理器不再接收事件）。
   */
  public on(event: string, handler: EventHandler): () => void {
    const handlers = this.handlers.get(event) ?? new Set<EventHandler>();
    handlers.add(handler);
    this.handlers.set(event, handlers);
    return () => {
      handlers.delete(handler);
    };
  }

  /**
   * 关闭连接（挂起请求立即失败）。
   * @returns 无返回值。
   */
  public close(): void {
    for (const [, entry] of this.pending) {
      entry.reject(new Error('SDK 连接已关闭'));
    }
    this.pending.clear();
    this.handlers.clear();
    this.options.socket.close();
  }

  /**
   * 绑定 socket 生命周期与消息。
   * @param socket 底层 socket（open / error / message / close 四事件）。
   * @returns 连接就绪 Promise（open 时 resolve，error 时 reject）。
   */
  private bindSocket(socket: SdkSocket): Promise<void> {
    const opened = new Promise<void>((resolve, reject) => {
      socket.onOpen(() => resolve());
      socket.onError((error) => reject(error));
    });
    socket.onMessage((text) => this.handleMessage(text));
    socket.onClose(() => this.rejectPending(new Error('SDK 连接已关闭')));
    return opened;
  }

  /**
   * 处理入站消息：响应按 id 关联，通知分发给订阅者。
   * @param text 原始消息文本（JSON-RPC 帧）。
   * @returns 无返回值。
   */
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

  /**
   * 是否为响应（有 id 无 method）。
   * @param message 已解析的 RPC 消息。
   * @returns 是响应返回 true（类型收窄为 RpcResponse）。
   */
  private isResponse(message: RpcMessage): message is RpcResponse {
    return 'id' in message && !('method' in message);
  }

  /**
   * 分发通知给订阅者。
   * @param message 通知消息（含 method 与可选 params）。
   * @returns 无返回值。
   */
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

  /**
   * 挂起请求全部失败。
   * @param error 拒绝原因（如连接已关闭）。
   * @returns 无返回值。
   */
  private rejectPending(error: Error): void {
    for (const [, entry] of this.pending) {
      entry.reject(error);
    }
    this.pending.clear();
  }
}
