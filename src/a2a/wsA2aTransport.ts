/**
 * A2A WebSocket 传输（E2 生产形态之二）。
 *
 * 与 {@link HttpA2aTransport} / {@link HttpA2aServerTransport} 实现**同一** `A2aTransport` 端口：
 * 协议（A2aClient / A2aServer / JSON-RPC）与门禁（验签 fail-closed）完全共用，差别只在承载方式
 * ——HTTP 是「一次 POST 一回包」，WebSocket 是「长连接双向帧」。长连接形态消除了每轮握手的
 * 开销，也可直接穿透只放行 Upgrade 的网关。
 *
 * 无第三方依赖：握手与帧编解码复用 `server/transport/wsConnection`（服务端裸帧 / 客户端掩码帧），
 * 不引入任何第三方 WebSocket 库（依赖预算为 0）。
 *
 * 安全：与 HTTP 传输同口径——发送前做 SSRF 字面量拦截（fail-closed，命中即不发帧）。
 */
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import type { Duplex } from 'node:stream';
import type { IncomingMessage } from 'node:http';
import type { RpcMessage } from '../server/core/jsonRpc.ts';
import { jsonRpc } from '../server/core/jsonRpc.ts';
import { WsConnection } from '../server/transport/wsConnection.ts';
import type { A2aTransport } from './a2aProtocol.ts';
import { A2A_MESSAGE_STREAM, A2A_TASKS_RESUBSCRIBE, A2A_TASKS_SUBSCRIBE } from './a2aProtocol.ts';
import { SsrfGuard } from '../security/ssrfGuard.ts';
import type { SsrfOptions } from '../security/ssrfGuard.ts';
import { log } from '../util/logger.ts';

/** 服务端监听路径（与 HTTP 的 `/a2a` 区分，避免与 appServer 的 `/ws` 冲突）。 */
export const A2A_WS_PATH = '/a2a-ws';

/** 客户端 WebSocket 传输：长连接承载 JSON-RPC，响应经 onMessage 回传。 */
export class WsA2aTransport implements A2aTransport {
  /** 响应回调（经 {@link onMessage} 注册；未注册时响应被丢弃）。 */
  private callback: ((message: RpcMessage) => void) | undefined;
  /** 已建立的连接（懒连接：首次发送时才握手；关闭后置空以便重连）。 */
  private connection: WsConnection | undefined;
  /** 进行中的握手（并发发送共享同一次握手，避免重复连接）。 */
  private connecting: Promise<WsConnection> | undefined;
  /** 主动关闭标记（关闭后不再自动重连）。 */
  private closed = false;
  /** 对端端点 URL（构造时固定）。 */
  private readonly endpoint: string;
  /** SSRF 策略：默认放行私有网段但拦截云元数据（出厂默认端点即 localhost）。 */
  private readonly ssrf: SsrfOptions;

  /**
   * @param endpoint 对端 `ws://` 端点（含路径，如 `ws://localhost:8790/a2a-ws`）。
   * @param ssrf SSRF 策略覆盖；缺省用 {@link defaultSsrfOptions}。
   */
  public constructor(endpoint: string, ssrf?: SsrfOptions) {
    this.endpoint = endpoint;
    this.ssrf = ssrf ?? SsrfGuard.defaultSsrfOptions();
  }

  /**
   * 端点合法性校验（含可选 DNS 解析），命中 SSRF 规则即抛错。
   * @returns 校验通过时 resolve；命中规则或域名不可解析时 reject。
   */
  public async validate(): Promise<void> {
    await SsrfGuard.assertNotSsrf(this.ssrfTarget(), this.ssrf);
  }

  /**
   * 订阅入站消息：注册回调，服务端帧解析为 JSON-RPC 后经此回传（供 A2aClient 按 id 关联）。
   * @param callback 收到响应消息时的处理回调（重复注册以最后一次为准）。
   * @returns 无返回值。
   */
  public onMessage(callback: (message: RpcMessage) => void): void {
    this.callback = callback;
  }

  /**
   * 发送一条消息：首帧触发懒握手，随后复用长连接发文本帧。
   * 发送前同步做 SSRF 字面量拦截，命中即丢弃不发（fail-closed）；握手/写失败静默吞掉，
   * 由上层调用超时兜底（与 HTTP 传输同一 fail-closed 口径）。
   * @param message 待发送的 JSON-RPC 消息。
   * @returns 无返回值（异步过程不暴露：失败由调用方超时观测）。
   */
  public send(message: RpcMessage): void {
    void this.sendAsync(message);
  }

  /** 关闭连接并禁止重连。
   * @returns 无返回值。
   */
  public close(): void {
    this.closed = true;
    this.connection?.close();
    this.connection = undefined;
    this.connecting = undefined;
  }

  /**
   * SSRF 判定目标：守卫只接受 http(s) 协议，而 WebSocket 端点写作 ws(s)://——二者主机与端口
   * 语义完全相同，故仅做协议映射后再交给守卫。
   * （不映射的后果：`ws://` 被判「非 HTTP(S) 协议」而**静默不发帧**，表现为调用侧超时。）
   * @returns 等价的 http(s) URL。
   */
  private ssrfTarget(): string {
    return this.endpoint.replace(/^ws:/, 'http:').replace(/^wss:/, 'https:');
  }

  /**
   * 异步发送实现：拦截 → 懒握手 → 写帧。
   * @param message 待发送的 JSON-RPC 消息。
   * @returns 写入完成（或静默失败）时的 Promise。
   */
  private async sendAsync(message: RpcMessage): Promise<void> {
    const verdict = SsrfGuard.inspectUrl(this.ssrfTarget(), this.ssrf);
    if (verdict.blocked) {
      log.warn('a2a.ssrfBlocked', { endpoint: this.endpoint, reason: verdict.reason });
      return;
    }
    try {
      const connection = await this.ensureConnection();
      connection.send(JSON.stringify(message));
    } catch (error) {
      // 握手/写失败由上层调用超时与 fail-closed 门禁兜底；留 debug 轨迹避免静默（审计 #13）。
      log.debug('a2a.ws.send.failed', {
        endpoint: this.endpoint,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * 取得可用连接：已有则复用，否则（去重地）发起一次握手。
   * @returns 已建立的连接。
   */
  private ensureConnection(): Promise<WsConnection> {
    if (this.closed) {
      return Promise.reject(new Error('WsA2aTransport 已关闭'));
    }
    if (this.connection !== undefined) {
      return Promise.resolve(this.connection);
    }
    this.connecting ??= this.handshake();
    return this.connecting;
  }

  /**
   * 执行 RFC6455 客户端握手：发 Upgrade 请求，成功后以 `client` 角色包装 socket
   * （客户端发出的每一帧都必须掩码）。
   * @returns 握手完成后的连接。
   */
  private handshake(): Promise<WsConnection> {
    return new Promise<WsConnection>((resolve, reject) => {
      const url = new URL(this.endpoint);
      const request = http.request({
        hostname: url.hostname,
        port: url.port === '' ? 80 : Number(url.port),
        path: `${url.pathname}${url.search}`,
        headers: {
          Connection: 'Upgrade',
          Upgrade: 'websocket',
          'Sec-WebSocket-Version': '13',
          'Sec-WebSocket-Key': randomBytes(16).toString('base64'),
        },
      });
      // 超时与「非 101 响应」都必须收敛为拒绝（2026-09-26 审计 S7）：原实现只监听 'upgrade' 与
      // 'error'，而对端回 405/426 这类普通 HTTP 响应时二者都不触发 ⇒ Promise 永不 settle、
      // socket 永久挂着；更糟的是 `this.connecting ??= this.handshake()` 会把这次永不兑现的
      // Promise 缓存在 `connecting` 上，**之后每次 send 都 await 同一个死 Promise**（传输永久毒化）。
      const timer = setTimeout(() => {
        request.destroy(
          new Error(`WebSocket 握手超时（${String(WsA2aTransport.HANDSHAKE_TIMEOUT_MS)}ms）`),
        );
      }, WsA2aTransport.HANDSHAKE_TIMEOUT_MS);
      const settle = (): void => {
        clearTimeout(timer);
        this.connecting = undefined;
      };
      request.on('response', (res: { statusCode?: number }) => {
        // 非 101：升级被拒（HTTP 版 A2A 端点会回 405/426）。必须显式拒绝并断开。
        res.statusCode;
        settle();
        request.destroy();
        reject(new Error(`WebSocket 握手被拒：HTTP ${String(res.statusCode ?? 0)}`));
      });
      request.on('upgrade', (_res, socket: Duplex, head: Buffer) => {
        clearTimeout(timer);
        const connection = new WsConnection(socket, undefined, 'client', head);
        connection.onMessage = (text) => this.deliver(text);
        connection.onClose = () => {
          this.connection = undefined;
          this.connecting = undefined;
        };
        this.connection = connection;
        // 握手前的首批字节须在 onMessage 注册之后处理，否则会落进默认空回调。
        connection.flush();
        resolve(connection);
      });
      request.on('error', (error: unknown) => {
        settle();
        reject(error instanceof Error ? error : new Error(String(error)));
      });
      request.end();
    });
  }

  /** 握手上限（毫秒）：对端不回任何东西时也必须收敛为有界等待。 */
  private static readonly HANDSHAKE_TIMEOUT_MS = 10_000;

  /**
   * 处理入站帧：解析 JSON-RPC 并投递给订阅者（非 JSON / 解析失败即丢弃）。
   * @param text 入站文本帧内容。
   * @returns 无返回值。
   */
  private deliver(text: string): void {
    const message = jsonRpc.parse(text);
    if (message === undefined || this.callback === undefined) {
      return;
    }
    this.callback(message);
  }
}

/** 服务端 WebSocket 传输：监听 Upgrade 握手，按 JSON-RPC id 关联回写响应帧。 */
export class WsA2aServerTransport implements A2aTransport {
  /** 入站请求处理回调（经 {@link onMessage} 注册，通常是 A2aServer 的处理入口）。 */
  private callback: ((message: RpcMessage) => void) | undefined;
  /**
   * **服务端唯一**路由键 → 挂起请求（含发起连接与对端原始 id）。
   *
   * 为什么不能用客户端给的 JSON-RPC id 当键（2026-09-26 审计 S1，P0）：每个 `A2aClient`
   * 的 id 都**从 1 开始编号**，两条连接并发发 id=1 时后到的 `set` 覆盖前一个写入器 ——
   * 响应被写回**后注册的那条连接**（发错人），先来的那条**永久挂起**。
   * 故入库时把 id 改写成服务端唯一键再交给处理回调，回写时按唯一键查表、还原对端原始 id。
   */
  private readonly resolvers = new Map<
    string,
    {
      readonly remoteId: number | string;
      readonly respond: (m: RpcMessage) => void;
      /** 是否流式请求（同一 id 允许多帧，终帧后回收）。 */
      readonly stream: boolean;
      /** 发起连接（close 时按连接回收挂起条目，防泄漏）。 */
      readonly connection: WsConnection;
    }
  >();
  /** 服务端唯一键的单调计数器（进程内唯一即可）。 */
  private seq = 0;
  /** 活跃 WebSocket 连接（close 时逐一关闭）。 */
  private readonly connections = new Set<WsConnection>();
  /** 连接 → 握手时携带的 Authorization（注入到每条请求的 params.assertion）。 */
  private readonly authorizations = new Map<WsConnection, string>();
  /** 底层 node:http 服务实例（listen 后才有值）。 */
  private server: http.Server | undefined;

  /**
   * 订阅入站消息：注册处理回调，客户端帧解析后经此转交（如 A2aServer 处理）。
   * @param callback 收到入站请求消息时的处理回调（重复注册以最后一次为准）。
   * @returns 无返回值。
   */
  public onMessage(callback: (message: RpcMessage) => void): void {
    this.callback = callback;
  }

  /**
   * 发送一条消息：按**服务端唯一键**关联到挂起请求并以其发起连接回写响应帧。
   * 无匹配键（通知/未知 id）时静默丢弃。
   * @param message 待回写的 JSON-RPC 消息（id 须为本传输在入库时改写的唯一键）。
   * @returns 无返回值。
   */
  public send(message: RpcMessage): void {
    if (!('id' in message)) {
      return;
    }
    const key = String(message.id);
    const entry = this.resolvers.get(key);
    if (entry !== undefined) {
      entry.respond({ ...message, id: entry.remoteId });
      if (!entry.stream || WsA2aServerTransport.isFinal(message)) {
        this.resolvers.delete(key);
      }
    }
  }

  /**
   * 回收一条连接的全部挂起请求（连接关闭/断开时调用）。
   *
   * 此前 onClose 只清 connections/authorizations——对端发完流式请求即断开时，resolvers
   * 条目只在收到终帧时删除 ⇒ 永久滞留（respond 对已关连接静默丢弃）。按连接索引回收。
   * @param connection 已关闭的连接。
   * @returns 无返回值。
   */
  private reclaim(connection: WsConnection): void {
    for (const [key, entry] of this.resolvers) {
      if (entry.connection === connection) {
        this.resolvers.delete(key);
      }
    }
  }

  /**
   * 在给定端口监听（返回实际端口）。仅处理 `A2A_WS_PATH` 的 Upgrade；普通 HTTP 请求回 426。
   * 默认只绑 `127.0.0.1`（2026-10-21），局域网互操作需显式 `OMNI_A2A_HOST=0.0.0.0`。
   * @param port 期望监听的端口（可传 0 取系统分配的临时端口）。
   * @returns **实际**监听的端口（由 `server.address()` 读取，port=0 时即临时端口）。
   */
  public async listen(port: number): Promise<number> {
    this.server = http.createServer((_req, res) => {
      res.on('error', () => {});
      res.writeHead(426, { upgrade: 'websocket' });
      res.end();
    });
    this.server.on('upgrade', (request, socket) => this.upgrade(request, socket));
    const server = this.server;
    const host = (process.env['OMNI_A2A_HOST'] ?? '').trim() || '127.0.0.1';
    return await new Promise<number>((resolve, reject) => {
      const onError = (error: Error): void => {
        reject(error);
      };
      server.once('error', onError);
      server.listen(port, host, () => {
        server.off('error', onError);
        const address = server.address();
        resolve(typeof address === 'object' && address !== null ? address.port : port);
      });
    });
  }

  /** 关闭传输：断开全部连接并停止监听，释放端口。
   * @returns 无返回值。
   */
  public close(): void {
    for (const connection of this.connections) {
      connection.close();
    }
    this.connections.clear();
    this.authorizations.clear();
    this.server?.close();
  }

  /**
   * RFC6455 服务端握手：校验路径与 `Sec-WebSocket-Key`，失败即销毁 socket（fail-closed，
   * 不对未知 Upgrade 路径开口子）。
   * @param request 升级请求。
   * @param socket 待升级的 TCP socket。
   * @returns 无返回值。
   */
  private upgrade(request: IncomingMessage, socket: Duplex): void {
    const key = request.headers['sec-websocket-key'];
    if (request.url !== A2A_WS_PATH || typeof key !== 'string') {
      socket.destroy();
      return;
    }
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${WsConnection.webSocketAcceptKey(key)}\r\n\r\n`,
    );
    const connection = new WsConnection(socket);
    this.connections.add(connection);
    const authorization = request.headers['authorization'];
    if (typeof authorization === 'string' && authorization.trim() !== '') {
      this.authorizations.set(connection, authorization);
    }
    connection.onClose = () => {
      this.connections.delete(connection);
      this.authorizations.delete(connection);
      this.reclaim(connection);
    };
    connection.onMessage = (text) => this.deliver(text, connection);
  }

  /**
   * 处理入站帧：解析 JSON-RPC，登记 id → 回写器后转交上层；非法帧与通知直接丢弃。
   * @param text 入站文本帧内容。
   * @param connection 该帧所属连接（响应按 id 回到发起连接）。
   * @returns 无返回值。
   */
  private deliver(text: string, connection: WsConnection): void {
    const message = jsonRpc.parse(text);
    if (message === undefined || !('method' in message)) {
      return;
    }
    const id = 'id' in message ? message.id : null;
    if (id === null) {
      return;
    }
    this.seq += 1;
    const key = `a2a-ws-${String(this.seq)}`;
    this.resolvers.set(key, {
      remoteId: id,
      respond: (response) => connection.send(JSON.stringify(response)),
      stream: WsA2aServerTransport.isStreaming(message.method),
      connection,
    });
    const enriched = this.attachAuthorization(message, connection);
    this.callback?.({ ...enriched, id: key });
  }

  /**
   * 判断是否为流式方法（同一 id 允许多帧）。
   * @param method JSON-RPC 方法名。
   * @returns 流式方法为 true。
   */
  private static isStreaming(method: string): boolean {
    return (
      method === A2A_MESSAGE_STREAM ||
      method === A2A_TASKS_SUBSCRIBE ||
      method === A2A_TASKS_RESUBSCRIBE
    );
  }

  /**
   * 判断流式响应的最后一帧（错误响应或 result.final === true）。
   * @param message JSON-RPC 响应。
   * @returns 最后一帧为 true。
   */
  private static isFinal(message: RpcMessage): boolean {
    if ('error' in message) return true;
    const result = (message as { readonly result?: unknown }).result;
    if (typeof result !== 'object' || result === null) return false;
    const record = result as Record<string, unknown>;
    if (record['final'] === true) return true;
    for (const key of ['statusUpdate', 'artifactUpdate'] as const) {
      const nested = record[key];
      if (
        typeof nested === 'object' &&
        nested !== null &&
        (nested as Record<string, unknown>)['final'] === true
      ) {
        return true;
      }
    }
    return false;
  }

  /**
   * 把握手时携带的 Authorization 注入请求参数 `assertion`（不覆盖已有值）。
   * @param message 入站消息。
   * @param connection 该帧所属连接。
   * @returns 注入后的消息。
   */
  private attachAuthorization(message: RpcMessage, connection: WsConnection): RpcMessage {
    const authorization = this.authorizations.get(connection);
    if (authorization === undefined) return message;
    const params = (message as { readonly params?: unknown }).params;
    const record =
      typeof params === 'object' && params !== null && !Array.isArray(params)
        ? { ...(params as Record<string, unknown>) }
        : {};
    if (record['assertion'] === undefined) record['assertion'] = authorization;
    return { ...message, params: record } as RpcMessage;
  }
}
