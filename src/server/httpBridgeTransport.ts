import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { jsonRpc, type RpcMessage, type RpcRequest } from './jsonRpc.js';
import type { Transport } from './lineTransport.js';
import { WsServer, type WsConnection } from './wsConnection.js';
import { EnterpriseAuth } from '../enterprise/index.js';

export class HttpBridgeTransport implements Transport {
  private callback: ((message: RpcMessage) => void) | undefined;
  private readonly pending = new Map<number | string, (message: RpcMessage) => void>();
  private readonly sseClients = new Set<ServerResponse>();
  private readonly wsClients = new Set<WsConnection>();
  /** 企业鉴权门禁（D2，opt-in）：设置后所有入站 RPC 调用需有效 Bearer 令牌，fail-closed。 */
  private readonly auth?: EnterpriseAuth;

  public constructor(auth?: EnterpriseAuth) {
    this.auth = auth;
  }

  /** 发送：带 id 的走挂起响应，通知广播给 SSE/WS。 */
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

  /** 订阅入站消息。 */
  public onMessage(callback: (message: RpcMessage) => void): void {
    this.callback = callback;
  }

  /** 处理 POST /rpc：解析请求、鉴权门禁、分发、返回响应。 */
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

  /** 注册 WebSocket 客户端（消息接管到同一 pending/广播）；开启门禁时先校验 Bearer 令牌。 */
  public registerWs(connection: WsConnection): void {
    this.wsClients.add(connection);
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
    connection.onClose = () => this.wsClients.delete(connection);
  }

  /** 分发请求并等待响应。 */
  private handleRequest(message: RpcRequest): Promise<RpcMessage> {
    return new Promise((resolve) => {
      this.pending.set(message.id, resolve);
      this.callback?.(message);
    });
  }

  /** 注册 SSE 客户端。 */
  public registerSse(response: ServerResponse): void {
    this.sseClients.add(response);
    response.on('close', () => this.sseClients.delete(response));
  }

  /** 广播通知给全部 SSE 客户端。 */
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

  /** 广播一条通知给全部 SSE / WS 客户端（供 live 视图推送工具参数增量等实时事件）。 */
  public notify(method: string, params: Record<string, unknown>): void {
    this.broadcast(jsonRpc.notify(method, params));
  }
}
