/** 最小 WebSocket 结构（与 WHATWG WebSocket 兼容，便于注入）。 */
export interface MinimalWebSocket {
  send(data: string): void;
  close(): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
  onerror: ((event: unknown) => void) | null;
}

/** SDK 传输插口：文本帧收发 + 生命周期回调（可替换为任意实现）。 */
export interface SdkSocket {
  send(text: string): void;
  close(): void;
  onOpen(handler: () => void): void;
  onMessage(handler: (text: string) => void): void;
  onClose(handler: () => void): void;
  onError(handler: (error: Error) => void): void;
}

/** WebSocket 传输实现（Node 22 全局 WebSocket / 浏览器同源）。 */
export class WebSocketSdkSocket implements SdkSocket {
  public constructor(private readonly socket: MinimalWebSocket) {}

  /** 连接指定 URL（缺省实现取全局 WebSocket）。 */
  public static connect(
    url: string,
    factory?: (url: string) => MinimalWebSocket,
  ): WebSocketSdkSocket {
    const creator = factory ?? globalWebSocketFactory();
    return new WebSocketSdkSocket(creator(url));
  }

  /** 发送文本帧：原样转发给底层 WebSocket。 */
  public send(text: string): void {
    this.socket.send(text);
  }

  /** 关闭底层 WebSocket 连接。 */
  public close(): void {
    this.socket.close();
  }

  /** 订阅连接建立：open 事件即触发 handler。 */
  public onOpen(handler: () => void): void {
    this.socket.onopen = () => handler();
  }

  /** 订阅入站消息：message 事件的 data 经 String() 归一为文本后交给 handler。 */
  public onMessage(handler: (text: string) => void): void {
    this.socket.onmessage = (event) => handler(String(event.data));
  }

  /** 订阅连接关闭：close 事件即触发 handler（无事件参数）。 */
  public onClose(handler: () => void): void {
    this.socket.onclose = () => handler();
  }

  /** 订阅错误：error 事件为 Error 时原样回调，否则包装为 new Error('WebSocket 错误')。 */
  public onError(handler: (error: Error) => void): void {
    this.socket.onerror = (event) =>
      handler(event instanceof Error ? event : new Error('WebSocket 错误'));
  }
}

/** 取全局 WebSocket 工厂（缺失即抛错，避免隐式依赖）。 */
function globalWebSocketFactory(): (url: string) => MinimalWebSocket {
  const creator = (globalThis as { WebSocket?: new (url: string) => MinimalWebSocket }).WebSocket;
  if (creator === undefined) {
    throw new Error('当前环境无全局 WebSocket，请注入 socket 工厂');
  }
  return (url) => new creator(url);
}
