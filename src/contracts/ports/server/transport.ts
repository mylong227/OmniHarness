import type { RpcMessage } from './rpcMessage.ts';
import type { SubscriptionChannel } from './subscriptionChannel.ts';
import type { RequestId } from './requestId.ts';

/** 传输层抽象：收发 JSON-RPC 消息。 */
export interface Transport {
  send(message: RpcMessage): void;
  onMessage(callback: (message: RpcMessage) => void): void;
  /**
   * 可选：为一条 `subscriptions/listen` 请求打开**长生命周期响应流**（2026-07-28）。
   *
   * 无此能力的传输（如 stdio/LineTransport）返回 undefined：服务端回落为
   * 「所有消息走共享通道 + `_meta.subscriptionId` 关联」（规范允许的 stdio 形态）。
   * 有能力的传输（Streamable HTTP/SSE）应把该请求的响应写成一条持续流，
   * 使 ack 与后续通知都落在同一个 POST 响应里。
   * @param requestId 发起 `subscriptions/listen` 的 JSON-RPC id（同时是 subscriptionId）。
   * @returns 订阅通道；不支持按请求分流时 undefined。
   */
  openSubscription?(requestId: RequestId): SubscriptionChannel | undefined;
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
