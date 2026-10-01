import type { RpcMessage } from '../server/rpcMessage.js';

/** 传输层抽象（A2A 自包含，不耦合 server 实现）。 */
export interface A2aTransport {
  /** 发送一条消息（请求/响应/通知）。 */
  send(message: RpcMessage): void;
  /** 订阅入站消息。 */
  onMessage(callback: (message: RpcMessage) => void): void;
  /** 可选：关闭传输（释放连接/端口）。 */
  close?(): void;
}
