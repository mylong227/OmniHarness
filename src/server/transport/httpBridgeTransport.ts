import { type ServerResponse } from 'node:http';
import { jsonRpc, type RpcMessage, type RpcRequest } from '../core/jsonRpc.js';
import type { Transport } from './lineTransport.js';
import { type WsConnection } from './wsConnection.js';
import { SseBackpressureGuard } from './sseBackpressureGuard.js';
import { EnterpriseAuth } from '../../enterprise/index.js';
import { PendingRequests } from '../../util/pendingRequests.js';

/** 传输层超时预算覆写（仅供单测注入；生产用类常量）。 */
export interface HttpBridgeTimeouts {
  /** 普通 RPC 的等待上限（毫秒）。 */
  readonly normalMs?: number;
  /** 长任务 RPC 的等待上限（毫秒）。 */
  readonly longMs?: number;
}

/** HTTP/WS/SSE 桥接传输：POST /rpc 与 WS 请求-响应共用 pending 表，通知广播给全部 SSE/WS 客户端（实现 {@link Transport}）。 */
export class HttpBridgeTransport implements Transport {
  /**
   * 单条**普通**入站 RPC 的等待上限（毫秒）：60 秒。
   *
   * 依据：普通 RPC（会话列表 / 配置 / 文件…）的正常量级是毫秒～秒。超时把它收敛为一条可解释的错误
   * 响应，而不是让 HTTP 连接与 pending 条目一起悬挂（2026-09-26 审计 S15）。
   *
   * **长任务 RPC 不适用本预算**，见 {@link HttpBridgeTransport.LONG_REQUEST_TIMEOUT_MS}。
   */
  public static readonly REQUEST_TIMEOUT_MS = 60_000;

  /**
   * **长任务** RPC 的等待上限（毫秒）：30 分钟。
   *
   * ## 为什么必须分开（2026-09-27 用户报「运行失败：RPC 错误」的根因）
   *
   * 这些方法**同步等待 agent 跑完**——`turns.run`（一个带工具的回合动辄几分钟）、`threads.create` /
   * `threads.continue`（同样会跑一轮）、`graph.run`（多 agent 编排更久）。原先 60 秒一刀切 ⇒
   * **回合仍在正常推进时报错**：界面写「运行失败」，服务端继续跑（状态分叉，用户看到错误横幅之后
   * 仍有工具调用完成）。服务端日志反复出现 `http.route.failed /rpc: RPC 超时（60000ms）` 即此。
   *
   * 仍**保留上限**（不是无限等）：S15 的「挂起可收敛为一条可解释错误」性质不放弃，只是把预算放到
   * 长任务的量级。真正需要更长时可走 `turns.abort` 主动收尾，而不是让连接永久悬挂。
   */
  public static readonly LONG_REQUEST_TIMEOUT_MS = 30 * 60_000;

  /** 走**长预算**的 RPC 方法（同步等待 agent / 编排跑完的那些）。 */
  private static readonly LONG_RUNNING_METHODS: ReadonlySet<string> = new Set([
    'turns.run',
    'threads.create',
    'threads.continue',
    'graph.run',
  ]);

  /**
   * 取某个 RPC 方法的等待上限（纯函数，便于单测）。
   * @param method JSON-RPC 方法名（`turns.run` 等长任务走长预算）
   * @returns 等待上限（毫秒）
   */
  public static timeoutFor(method: string): number {
    return HttpBridgeTransport.LONG_RUNNING_METHODS.has(method)
      ? HttpBridgeTransport.LONG_REQUEST_TIMEOUT_MS
      : HttpBridgeTransport.REQUEST_TIMEOUT_MS;
  }

  /** 入站消息回调（AppServer 注册的处理器）。 */
  private callback: ((message: RpcMessage) => void) | undefined;
  /** 等待响应的请求表：请求 id → 收尾通道（本传输只用成功通道，见 send）。 */
  private readonly pending = new PendingRequests<number | string, RpcMessage>();
  /** SSE 长连接客户端集合（连接断开自动移除）。 */
  private readonly sseClients = new Set<ServerResponse>();
  /**
   * SSE 客户端背压守卫：委托 {@link SseBackpressureGuard} 跟踪每个慢客户端连续写失败次数，
   * 超阈值即丢弃该客户端（fail-closed 偏严，避免单条慢连接拖垮服务端事件总线）。
   */
  private readonly sseBackpressure = new SseBackpressureGuard();
  /** WebSocket 客户端集合（连接关闭自动移除）。 */
  private readonly wsClients = new Set<WsConnection>();
  /** 企业鉴权门禁（D2，opt-in）：设置后所有入站 RPC 调用需有效 Bearer 令牌，fail-closed。 */
  private readonly auth?: EnterpriseAuth | undefined;
  /** 超时预算覆写（单测注入；缺省用类常量）。 */
  private readonly timeouts: HttpBridgeTimeouts;
  /**
   * 「全部客户端已断开」回调（由 AppServer 注册）：用于把挂起的审批上行按 deny 兑现，
   * 避免回合永久挂起（2026-09-22 修，审计 P2）。
   */
  private onAllClientsGone: (() => void) | undefined;
  /** 是否曾有过客户端：只在「有 → 无」的跃迁上触发回调，避免启动时空触发。 */
  private hadClients = false;

  /**
   * 创建桥接传输（可选注入企业鉴权与超时预算）。
   * @param auth 企业鉴权门禁（opt-in；缺省则不做 Bearer 校验）
   * @param timeouts 超时预算覆写（**仅供单测**把 60s / 30min 缩到毫秒级；生产不传即用类常量）
   */
  public constructor(auth?: EnterpriseAuth, timeouts?: HttpBridgeTimeouts) {
    this.auth = auth;
    this.timeouts = timeouts ?? {};
  }

  /**
   * 取某方法实际生效的等待上限（实例级：允许单测覆写）。
   * @param method JSON-RPC 方法名
   * @returns 毫秒
   */
  private budgetFor(method: string): number {
    return HttpBridgeTransport.LONG_RUNNING_METHODS.has(method)
      ? (this.timeouts.longMs ?? HttpBridgeTransport.LONG_REQUEST_TIMEOUT_MS)
      : (this.timeouts.normalMs ?? HttpBridgeTransport.REQUEST_TIMEOUT_MS);
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
      // 只有「谁来兑现这个响应」这一条通道：本传输的在途请求按契约必被上层回写（无超时/拒绝通道）。
      this.pending.settle(message.id, message);
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
    try {
      return await this.handleRequest(message);
    } catch (error) {
      // 超时/内部异常必须落成**一条 JSON-RPC error 响应**，而不是让它冒泡成 HTTP 500。
      //
      // 原先直接 `return this.handleRequest(...)`：超时 reject 冒到 httpServer 的 route 兜底，写出
      // `500 {"error":"internal"}`。而前端 ApiClient 把「有 error 字段」当 JSON-RPC 错误读
      // `error.message` —— `"internal"` 是字符串，`.message` 为 undefined，于是界面只剩一句没有任何
      // 归因的「RPC 错误」（2026-09-27 用户报的「运行失败：RPC 错误。可尝试切换模型或检查 API Key。」）。
      // 真正的超时原因在客户端 100% 丢失，用户只能去猜模型与 API Key。
      const text = error instanceof Error ? error.message : String(error);
      return jsonRpc.errorResponse(message.id, HttpBridgeTransport.errorCodeFor(text), text);
    }
  }

  /**
   * 把失败原因映射为 JSON-RPC 错误码（纯函数，便于单测）。
   * @param text 失败原因文本。
   * @returns `-32002`（等待超时，客户端应提示「可继续等待/中止」）或 `-32000`（其它服务端错误）。
   */
  public static errorCodeFor(text: string): number {
    return text.startsWith('RPC 超时') ? -32002 : -32000;
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
          // 超时/内部异常都必须变成**一条有 id 的错误响应**：否则调用方的 HTTP 请求永远等不到
          // 答复（原实现无超时、无拒绝通道，见 2026-09-26 审计 S15）。
          try {
            const response = await this.handleRequest(message);
            connection.send(JSON.stringify(response));
          } catch (error) {
            connection.send(
              JSON.stringify(
                jsonRpc.errorResponse(
                  message.id,
                  -32000,
                  error instanceof Error ? error.message : String(error),
                ),
              ),
            );
          }
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
   *
   * 必须带超时（2026-09-26 审计 S15）：原实现只登记 `{resolve}`、既无超时也无拒绝通道，
   * 而对端可自选 JSON-RPC id —— 重复 id 会覆盖 `PendingRequests` 里的旧条目，使**先到的那条**
   * 永远等不到答复（HTTP 侧连接悬挂、条目泄漏）。超时把它收敛为一条可解释的错误响应。
   * @param message 入站 RPC 请求。
   * @returns 上层处理完成后回写的响应消息。
   */
  private handleRequest(message: RpcRequest): Promise<RpcMessage> {
    return new Promise<RpcMessage>((resolve, reject) => {
      // 预算**按方法**取：普通 RPC 60s（防悬挂/泄漏），长任务 RPC（turns.run 等同步等 agent 的）30min
      // —— 一刀切 60s 会在回合仍在正常推进时报错（详见 LONG_REQUEST_TIMEOUT_MS 的说明）。
      const ms = this.budgetFor(message.method);
      this.pending.register(
        message.id,
        { resolve, reject },
        {
          ms,
          onTimeout: (handlers) => {
            handlers.reject?.(new Error(`RPC 超时（${ms}ms）`));
          },
        },
      );
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
      this.sseBackpressure.remove(response);
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
      // 背压兜底：对端消费慢、`write` 返回 false 时累计计数，连续超限即丢弃慢客户端
      // （宁可少推一个慢连接，也不让服务端事件总线被单条慢连接拖垮）。
      if (client.write(ssePayload)) {
        this.sseBackpressure.clear(client);
        continue;
      }
      if (this.sseBackpressure.hit(client)) {
        this.sseClients.delete(client);
        try {
          client.end();
        } catch {
          // 已断开：忽略
        }
        this.notifyIfAllClientsGone();
        continue;
      }
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
