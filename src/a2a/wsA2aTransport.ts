/**
 * A2A WebSocket 传输（E2 生产形态之二）。
 *
 * 与 {@link HttpA2aTransport} / {@link HttpA2aServerTransport} 实现**同一** `A2aTransport` 端口：
 * 协议（A2aClient / A2aServer / JSON-RPC）与门禁（验签 fail-closed）完全共用，差别只在承载方式
 * ——HTTP 是「一次 POST 一回包」，WebSocket 是「长连接双向帧」。长连接形态消除了每轮握手的
 * 开销，也可直接穿透只放行 Upgrade 的网关。
 *
 * 零依赖：握手与帧编解码复用 `server/transport/wsConnection`（服务端裸帧 / 客户端掩码帧），
 * 不引入任何第三方 WebSocket 库（依赖预算为 0）。
 *
 * 安全：与 HTTP 传输同口径——发送前做 SSRF 字面量拦截（fail-closed，命中即不发帧）。
 */
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import type { Duplex } from 'node:stream';
import type { IncomingMessage } from 'node:http';
import type { RpcMessage } from '../server/core/jsonRpc.js';
import { jsonRpc } from '../server/core/jsonRpc.js';
import { WsConnection, webSocketAcceptKey } from '../server/transport/wsConnection.js';
import type { A2aTransport } from './a2aProtocol.js';
import { inspectUrl, assertNotSsrf, defaultSsrfOptions } from '../security/ssrfGuard.js';
import type { SsrfOptions } from '../security/ssrfGuard.js';
import { log } from '../util/logger.js';

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
    this.ssrf = ssrf ?? defaultSsrfOptions();
  }

  /**
   * 端点合法性校验（含可选 DNS 解析），命中 SSRF 规则即抛错。
   * @returns 校验通过时 resolve；命中规则或域名不可解析时 reject。
   */
  public async validate(): Promise<void> {
    await assertNotSsrf(this.ssrfTarget(), this.ssrf);
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
    const verdict = inspectUrl(this.ssrfTarget(), this.ssrf);
    if (verdict.blocked) {
      log.warn('a2a.ssrfBlocked', { endpoint: this.endpoint, reason: verdict.reason });
      return;
    }
    try {
      const connection = await this.ensureConnection();
      connection.send(JSON.stringify(message));
    } catch {
      /* 握手/写失败：由上层调用超时与 fail-closed 门禁观测 */
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
      request.on('upgrade', (_res, socket: Duplex, head: Buffer) => {
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
        this.connecting = undefined;
        reject(error instanceof Error ? error : new Error(String(error)));
      });
      request.end();
    });
  }

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
  /** 挂起请求的 id → 响应写入器映射（send 命中 id 时把响应帧写回发起连接）。 */
  private readonly resolvers = new Map<number | string, (m: RpcMessage) => void>();
  /** 活跃 WebSocket 连接（close 时逐一关闭）。 */
  private readonly connections = new Set<WsConnection>();
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
   * 发送一条消息：按 JSON-RPC id 关联到挂起请求并以其发起连接回写响应帧。
   * 无匹配 id（通知/未知 id）时静默丢弃。
   * @param message 待回写的 JSON-RPC 消息（须携带 id 才能关联）。
   * @returns 无返回值。
   */
  public send(message: RpcMessage): void {
    if (!('id' in message)) {
      return;
    }
    const write = this.resolvers.get(message.id);
    if (write !== undefined) {
      this.resolvers.delete(message.id);
      write(message);
    }
  }

  /**
   * 在给定端口监听（返回实际端口）。仅处理 `A2A_WS_PATH` 的 Upgrade；普通 HTTP 请求回 426。
   * @param port 期望监听的端口（可传 0 取系统分配的临时端口）。
   * @returns **实际**监听的端口（由 `server.address()` 读取，port=0 时即临时端口）。
   */
  public async listen(port: number): Promise<number> {
    this.server = http.createServer((_req, res) => {
      res.writeHead(426, { upgrade: 'websocket' });
      res.end();
    });
    this.server.on('upgrade', (request, socket) => this.upgrade(request, socket));
    const server = this.server;
    return new Promise<number>((resolve) => {
      server.listen(port, () => {
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
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${webSocketAcceptKey(key)}\r\n\r\n`,
    );
    const connection = new WsConnection(socket);
    this.connections.add(connection);
    connection.onClose = () => this.connections.delete(connection);
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
    this.resolvers.set(id, (response) => connection.send(JSON.stringify(response)));
    this.callback?.(message);
  }
}
