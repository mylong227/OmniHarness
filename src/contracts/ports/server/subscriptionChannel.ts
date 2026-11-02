import type { RpcMessage } from './rpcMessage.ts';

/**
 * @beta
 * 一条长生命周期订阅的发送通道（`subscriptions/listen` 的响应流）。
 *
 * 传输实现负责把消息写到**发起该 listen 请求的那条流**上（HTTP 是那条 POST 的响应；
 * stdio 是共享通道）。关闭通道表示传输层结束该流；协议层的「优雅关闭」由服务端先发
 * 完成响应、再调用 `close()`。
 */
export interface SubscriptionChannel {
  /**
   * 向该订阅流写一条消息。
   * @param message RPC 消息（通知或最终的完成响应）。
   * @returns 无返回值。
   */
  send(message: RpcMessage): void;

  /**
   * 关闭底层流（不再写任何消息）。
   * @returns 无返回值。
   */
  close(): void;
}
