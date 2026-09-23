import { type ServerResponse } from 'node:http';
import { jsonRpc, type RpcMessage, type RpcRequest } from '../core/jsonRpc.js';
import type { Transport } from './lineTransport.js';
import { type WsConnection } from './wsConnection.js';
import { EnterpriseAuth } from '../../enterprise/index.js';

/** HTTP/WS/SSE 桥接传输：POST /rpc 与 WS 请求-响应共用 pending 表，通知广播给全部 SSE/WS 客户端（实现 {@link Transport}）。 */
export class HttpBridgeTransport implements Transport {
  /** 入站消息回调（AppServer 注册的处理器）。 */
  private callback: ((message: RpcMessage) => void) | undefined;
  /** 等待响应的请求表：请求 id → 响应回调。 */
  private readonly pending = new Map<number | string, (message: RpcMessage) => void>();
  /** SSE 长连接客户端集合（连接断开自动移除）。 */
  private readonly sseClients = new Set<ServerResponse>();
  /** WebSocket 客户端集合（连接关闭自动移除）。 */
  private readonly wsClients = new Set<WsConnection>();
  /** 企业鉴权门禁（D2，opt-in）：设置后所有入站 RPC 调用需有效 Bearer 令牌，fail-closed。 */
  private readonly auth?: EnterpriseAuth | undefined;
  /**
   * 「全部客户端已断开」回调（由 AppServer 注册）：用于把挂起的审批上行按 deny 兑现，
   * 避免回合永久挂起（2026-09-22 修，审计 P2）。
   */
  private onAllClientsGone: (() => void) | undefined;
  /** 是否曾有过客户端：只在「有 → 无」的跃迁上触发回调，避免启动时空触发。 */
  private hadClients = false;

  /**
   * 创建桥接传输（可选注入企业鉴权）。
   * @param auth 企业鉴权门禁（opt-in；缺省则不做 Bearer 校验）
   */
  public constructor(auth?: EnterpriseAuth) {
    this.auth = auth;
  }

  /**
   * 注册「全部客户端已断开」回调（见 {@link Transport.setOnAllClientsGone}）。
   * @param callback 无参回调
   * @returns 无返回值。
   */
  public setOnAllClientsGone(callback: () => void): void {
    this.onAllClientsGone = callback;
  }

  /**
   * 客户端集合变动后调用：从「有客户端」变为「没有客户端」时触发一次回调。
   * @returns 无返回值。
   */
  private notifyIfAllClientsGone(): void {
    const empty = this.sseClients.size === 0 && this.wsClients.size === 0;
    if (empty && this.hadClients) {
      this.hadClients = false;
      this.onAllClientsGone?.();
    }
  }

  /**
   * 发送：带 id 的走挂起响应，通知广播给 SSE/WS。
   * @param message RPC 消息（响应或通知）。
   * @returns 无返回值。
   */
  public send(message: RpcMessage): void {
    if ('id' in message && message.id !== undefined) {
      const respond = this.pending.get(message.id);
      if (respond !== undefined) {
        respond(message);
        this.pending.delete(message.id);
      }
      return;
    }
    this.broadcast(message);
  }

  /**
   * 订阅入站消息。
   * @param callback 入站请求处理器（重复注册以最后一次为准）。
   * @returns 无返回值。
   */
  public onMessage(callback: (message: RpcMessage) => void): void {
    this.callback = callback;
  }

  /**
   * 处理 POST /rpc：解析请求、鉴权门禁、分发、返回响应。
   * @param body 原始请求体（JSON-RPC 文本）。
   * @param authHeader Authorization 头原文（开启企业鉴权时校验 Bearer 令牌）。
   * @returns RPC 响应消息（解析失败 / 未认证时返回对应 error 响应）。
   */
  public async handlePost(body: string, authHeader?: string): Promise<RpcMessage> {
    const message = jsonRpc.parse(body);
    if (message === undefined || !jsonRpc.isRequest(message)) {
      return jsonRpc.errorResponse(-1, -32700, '无效请求');
    }
    if (this.auth !== undefined) {
      const subject = await this.auth.authenticate(authHeader);
      if (subject === null) {
        return jsonRpc.errorResponse(
          message.id,
          -32001,
          '未认证或令牌无效（需 Authorization: Bearer <token>）',
        );
      }
    }
    return this.handleRequest(message);
  }

  /**
   * 注册 WebSocket 客户端（消息接管到同一 pending/广播）；开启门禁时先校验 Bearer 令牌。
   * @param connection 新升级的 WS 连接（其 onMessage / onClose 被接管）。
   * @returns 无返回值。
   */
  public registerWs(connection: WsConnection): void {
    this.wsClients.add(connection);
    this.hadClients = true;
    connection.onMessage = (text: string) => {
      const message = jsonRpc.parse(text);
      if (message !== undefined && jsonRpc.isRequest(message)) {
        void (async () => {
          if (this.auth !== undefined) {
            const subject = await this.auth.authenticate(connection.authorization);
            if (subject === null) {
              connection.send(
                JSON.stringify(
                  jsonRpc.errorResponse(
                    message.id,
                    -32001,
                    '未认证或令牌无效（需 Authorization: Bearer <token>）',
                  ),
                ),
              );
              return;
            }
          }
          const response = await this.handleRequest(message);
          connection.send(JSON.stringify(response));
        })();
      }
    };
    connection.onClose = () => {
      this.wsClients.delete(connection);
      this.notifyIfAllClientsGone();
    };
  }

  /**
   * 分发请求并等待响应。
   * @param message 入站 RPC 请求。
   * @returns 上层处理完成后回写的响应消息。
   */
  private handleRequest(message: RpcRequest): Promise<RpcMessage> {
    return new Promise((resolve) => {
      this.pending.set(message.id, resolve);
      this.callback?.(message);
    });
  }

  /**
   * 注册 SSE 客户端。
   * @param response event-stream 响应对象（连接关闭时自动移出集合）。
   * @returns 无返回值。
   */
  public registerSse(response: ServerResponse): void {
    this.sseClients.add(response);
    this.hadClients = true;
    response.on('close', () => {
      this.sseClients.delete(response);
      this.notifyIfAllClientsGone();
    });
  }

  /**
   * 广播通知给全部 SSE 客户端。
   * @param message 通知消息（SSE data 帧与 WS 文本帧各发一份）。
   * @returns 无返回值。
   */
  private broadcast(message: RpcMessage): void {
    const ssePayload = `data: ${JSON.stringify(message)}\n\n`;
    for (const client of this.sseClients) {
      client.write(ssePayload);
    }
    const wsPayload = JSON.stringify(message);
    for (const client of this.wsClients) {
      client.send(wsPayload);
    }
  }

  /**
   * 广播一条通知给全部 SSE / WS 客户端（供 live 视图推送工具参数增量等实时事件）。
   * @param method 通知方法名。
   * @param params 通知参数。
   * @returns 无返回值。
   */
  public notify(method: string, params: Record<string, unknown>): void {
    this.broadcast(jsonRpc.notify(method, params));
  }
}
