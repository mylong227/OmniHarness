import { jsonRpc, type RpcMessage, type RpcRequest } from '../core/jsonRpc.ts';
import type { Transport } from './lineTransport.ts';
import { type WsConnection } from './wsConnection.ts';
import { SseFanout } from './sseFanout.ts';
import { EnterpriseAuth } from '../../enterprise/index.ts';
import { PendingRequests } from '../../../kernel/util/concurrency/pendingRequests.ts';

/**
 * 「全部客户端断开」宽限期解析：显式入参 > env `OMNI_CLIENTS_GONE_GRACE_MS` > 缺省 10s；
 * 0 = 旧的同步立即语义（刷新会饿死挂起提问，仅供特殊部署显式选择）。
 * 模块级箭头常量：类方法数已顶上帝类闸，逃生门按口径用箭头常量。
 */
const resolveClientsGoneGraceMs = (explicit?: number): number => {
  if (typeof explicit === 'number' && Number.isFinite(explicit)) {
    return explicit > 0 ? Math.floor(explicit) : 0;
  }
  const raw = process.env['OMNI_CLIENTS_GONE_GRACE_MS'];
  if (raw !== undefined && raw.trim() !== '') {
    const parsed = Number(raw);
    if (Number.isFinite(parsed)) {
      return parsed > 0 ? Math.floor(parsed) : 0;
    }
  }
  return 10_000;
};

/** 传输层超时预算覆写（仅供单测注入；生产用类常量）。 */
export interface HttpBridgeTimeouts {
  /** 普通 RPC 的等待上限（毫秒）。 */
  readonly normalMs?: number;
  /** 长任务 RPC 的等待上限（毫秒）。 */
  readonly longMs?: number;
  /**
   * 「全部客户端断开」宽限期（毫秒，仅供单测注入；生产用类常量 10s）。
   * `0` = 保持旧的立即触发语义（断连收尾判据用）。
   */
  readonly clientsGoneGraceMs?: number;
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
  /**
   * SSE 扇出器（连接集合 / 背压 / `thread.event` 重放历史，2026-10-21 抽离）。
   *
   * 宿主只保留一个字段：`sse.register(...)` 与 `sse.broadcast(...)`。这样
   * `HttpBridgeTransport` 不再因重连重放的状态而越过「上帝类」属性/方法数门禁。
   */
  public readonly sse = new SseFanout({
    onClientAdded: () => {
      this.hadClients = true;
    },
    onClientsGone: () => {
      this.notifyIfAllClientsGone();
    },
  });
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
   * 「全部客户端断开」的**宽限期**（毫秒，2026-11-01）：跃迁发生后延迟触发回调，
   * 期间任一客户端接入即取消（fire 时复核仍为空才触发）。
   *
   * 为什么需要：页面刷新 / 网络抖动会瞬时清空客户端集合，立即 deny 会把「正在等待作答」的
   * 提问/审批饿死——模型拿到占位答案继续跑，用户刷新回来卡片也没了（实测 sess_mvx7hrh6 同族
   * 报障的姊妹形态）。宽限期 + `question.pending`/`approval.pending` 恢复 RPC 共同构成断连恢复：
   * 刷新在宽限期内重连 → 客户端主动拉取挂起上行 → 卡片恢复，作答不丢。
   * 生效值见模块级 `resolveClientsGoneGraceMs`（缺省 10s，env `OMNI_CLIENTS_GONE_GRACE_MS` 可调）。
   */
  /** 生效宽限期（单测可覆写为 0 = 旧的立即语义）。 */
  private readonly clientsGoneGraceMs: number;
  /** 宽限期定时器（期内核复即取消；重复跃迁重置）。 */
  private clientsGoneTimer: ReturnType<typeof setTimeout> | undefined;

  /**
   * 创建桥接传输（可选注入企业鉴权与超时预算）。
   * @param auth 企业鉴权门禁（opt-in；缺省则不做 Bearer 校验）
   * @param timeouts 超时预算覆写（**仅供单测**把 60s / 30min / 宽限期缩到毫秒级；生产不传即用类常量）
   */
  public constructor(auth?: EnterpriseAuth, timeouts?: HttpBridgeTimeouts) {
    this.auth = auth;
    this.timeouts = timeouts ?? {};
    this.clientsGoneGraceMs = timeouts?.clientsGoneGraceMs ?? resolveClientsGoneGraceMs();
  }

  /**
   * 取某方法实际生效的等待上限（实例级：允许单测覆写）。
   * @param method JSON-RPC 方法名
   * @returns 毫秒
   */
  /**
   * 注册「全部客户端已断开」回调（见 {@link Transport.setOnAllClientsGone}）。
   * @param callback 无参回调
   * @returns 无返回值。
   */
  public setOnAllClientsGone(callback: () => void): void {
    this.onAllClientsGone = callback;
  }

  /**
   * 客户端集合变动后调用：从「有客户端」变为「没有客户端」时**安排**回调（宽限期内复联即取消）。
   *
   * 宽限期语义（2026-11-01，默认 10s，可注入覆写；0 = 旧的同步立即语义）：页面刷新 /
   * 网络抖动会瞬时清空客户端集合，立即 deny 会把「正在等待作答」的提问/审批饿死——模型拿到
   * 占位答案继续跑，用户刷新回来卡片也没了。宽限期 + `question.pending`/`approval.pending`
   * 恢复 RPC 共同构成断连恢复。fire 时**复核**仍无客户端才触发；宽限期内新客户端接入不主动
   * 取消定时器，靠 fire 时复核兜住（接入会把 hadClients 置回 true，下一次跃迁重新走完整周期）。
   * @returns 无返回值。
   */
  private notifyIfAllClientsGone(): void {
    const empty = this.sse.count() === 0 && this.wsClients.size === 0;
    if (!empty || !this.hadClients) return;
    this.hadClients = false;
    if (this.clientsGoneGraceMs <= 0) {
      this.onAllClientsGone?.();
      return;
    }
    if (this.clientsGoneTimer !== undefined) {
      clearTimeout(this.clientsGoneTimer);
    }
    this.clientsGoneTimer = setTimeout(() => {
      this.clientsGoneTimer = undefined;
      if (this.sse.count() === 0 && this.wsClients.size === 0) {
        this.onAllClientsGone?.();
      }
    }, this.clientsGoneGraceMs);
    // 宽限期定时器不承载「兜底」语义（真正的兜底是审批/提问上行超时），unref 不影响正确性。
    this.clientsGoneTimer.unref?.();
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
      // 等待上限：长任务方法走长预算（实例级覆写供单测缩到毫秒级）。
      const ms = HttpBridgeTransport.LONG_RUNNING_METHODS.has(message.method)
        ? (this.timeouts.longMs ?? HttpBridgeTransport.LONG_REQUEST_TIMEOUT_MS)
        : (this.timeouts.normalMs ?? HttpBridgeTransport.REQUEST_TIMEOUT_MS);
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
   * 广播通知给全部 SSE / WS 客户端（SSE 由 {@link SseFanout} 处理 id 与重放）。
   * @param message 通知消息。
   * @returns 无返回值。
   */
  private broadcast(message: RpcMessage): void {
    this.sse.broadcast(message);
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
