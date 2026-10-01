import type { RpcMessage } from './rpcMessage.js';

/** 传输层抽象：收发 JSON-RPC 消息。 */
export interface Transport {
  send(message: RpcMessage): void;
  onMessage(callback: (message: RpcMessage) => void): void;
  /**
   * 可选：注册「全部客户端已断开」回调。
   *
   * 用途（2026-09-22 修，审计 P2）：审批上行是**等客户端回答**的，而客户端可随时消失
   * （关页面 / 网络断）。有此信号后，服务端可立即把挂起审批按 deny 兑现（fail-closed），
   * 而不是让回合白等到超时窗口结束。只在真的从「有客户端」变为「没有客户端」时触发。
   * @param callback 无参回调（由 AppServer 注册，用于兑现挂起审批）
   * @returns 无返回值。
   */
  setOnAllClientsGone?(callback: () => void): void;
}
