import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import type { AppServer } from './appServer.js';
import { JsonRpc, type RpcMessage, type RpcRequest } from './jsonRpc.js';
import type { Transport } from './lineTransport.js';
import { WsServer, type WsConnection } from './wsTransport.js';
import { EnterpriseAuth } from '../enterprise/index.js';
import type { Metrics } from './metrics.js';
import { log, Logger } from '../util/logger.js';

/** HTTP 桥接传输：POST/WS 请求关联响应，通知广播到 SSE/WS 客户端。 */
export class HttpBridgeTransport implements Transport {
  private callback: ((message: RpcMessage) => void) | undefined;
  private readonly pending = new Map<number | string, (message: RpcMessage) => void>();
  private readonly sseClients = new Set<ServerResponse>();
  private readonly wsClients = new Set<WsConnection>();
  /** 企业鉴权门禁（D2，opt-in）：设置后所有入站 RPC 调用需有效 Bearer 令牌，fail-closed。 */
  private readonly auth?: EnterpriseAuth;

  constructor(auth?: EnterpriseAuth) {
    this.auth = auth;
  }

  /** 发送：带 id 的走挂起响应，通知广播给 SSE/WS。 */
  send(message: RpcMessage): void {
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
  onMessage(callback: (message: RpcMessage) => void): void {
    this.callback = callback;
  }

  /** 处理 POST /rpc：解析请求、鉴权门禁、分发、返回响应。 */
  async handlePost(body: string, authHeader?: string): Promise<RpcMessage> {
    const message = JsonRpc.parse(body);
    if (message === undefined || !JsonRpc.isRequest(message)) {
      return JsonRpc.errorResponse(-1, -32700, '无效请求');
    }
    if (this.auth !== undefined) {
      const subject = await this.auth.authenticate(authHeader);
      if (subject === null) {
        return JsonRpc.errorResponse(
          message.id,
          -32001,
          '未认证或令牌无效（需 Authorization: Bearer <token>）',
        );
      }
    }
    return this.handleRequest(message);
  }

  /** 注册 WebSocket 客户端（消息接管到同一 pending/广播）；开启门禁时先校验 Bearer 令牌。 */
  registerWs(connection: WsConnection): void {
    this.wsClients.add(connection);
    connection.onMessage = (text: string) => {
      const message = JsonRpc.parse(text);
      if (message !== undefined && JsonRpc.isRequest(message)) {
        void (async () => {
          if (this.auth !== undefined) {
            const subject = await this.auth.authenticate(connection.authorization);
            if (subject === null) {
              connection.send(
                JSON.stringify(
                  JsonRpc.errorResponse(
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
  registerSse(response: ServerResponse): void {
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
  notify(method: string, params: Record<string, unknown>): void {
    this.broadcast(JsonRpc.notify(method, params));
  }
}

/** HTTP 服务选项。 */
export interface HttpServerOptions {
  readonly app: AppServer;
  readonly bridge: HttpBridgeTransport;
  readonly webDir: string;
  readonly metrics?: Metrics;
}

/** 健康检查结果（供容器编排探针消费）。 */
export interface HealthStatus {
  /** `ok` 可接流；`degraded` 核心组件缺失，不应接流。 */
  readonly status: 'ok' | 'degraded';
  /** 进程已运行秒数。 */
  readonly uptimeSeconds: number;
  /**
   * 各组件检查结果。`app` 与 `bridge` 是**核心项**，决定 `status`；
   * `webDir`/`metrics` 仅为诊断信息，缺失不影响就绪判定（属可选能力）。
   */
  readonly checks: Readonly<Record<string, boolean>>;
}

/** HTTP + SSE + WebSocket 服务：静态页 + JSON-RPC + 事件推送（零依赖）。 */
export class HttpServer {
  private readonly server: Server;
  /** WS 服务端：close 时须先强制断开 upgrade 连接，否则 server.close 永不回调。 */
  private readonly ws: WsServer;
  /** 启动时刻（用于 uptime，构造即计时）。 */
  private readonly startedAt = Date.now();

  constructor(private readonly options: HttpServerOptions) {
    this.server = createServer((request, response) => void this.route(request, response));
    this.ws = new WsServer(this.server, (connection) => this.options.bridge.registerWs(connection));
  }

  /** 启动并返回端口。 */
  start(port: number): Promise<number> {
    return new Promise((resolve) => {
      this.server.listen(port, () => {
        const address = this.server.address();
        resolve(typeof address === 'object' && address !== null ? address.port : port);
      });
    });
  }

  /**
   * 关闭（强制断开全部连接）。
   *
   * 顺序有讲究：先断 WS——upgrade 后的 socket 已脱离 HTTP 连接管辖，
   * `closeAllConnections` 覆盖不到，漏掉会让 `server.close()` 永不回调（服务关不掉）；
   * 再断普通 HTTP 连接，最后关监听。
   */
  close(): Promise<void> {
    return new Promise((resolve) => {
      this.ws.closeAll();
      this.server.closeAllConnections?.();
      this.server.close(() => resolve());
    });
  }

  /** 路由。每条请求建独立 traceId，全程日志自动携带，便于跨调用串联。 */
  private async route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = request.url ?? '/';
    const traceId = Logger.nextTraceId(
      typeof request.headers['x-trace-id'] === 'string' ? request.headers['x-trace-id'] : undefined,
    );
    await log.withTrace(traceId, async () => {
      const started = Date.now();
      const method = request.method ?? 'GET';
      log.info('http.request.start', { method, url });
      if (request.method === 'GET' && url === '/events') {
        this.openSse(response);
      } else if (request.method === 'GET' && url === '/metrics') {
        this.serveMetrics(response);
      } else if (request.method === 'GET' && url === '/healthz') {
        this.serveHealth(response, 'live');
      } else if (request.method === 'GET' && url === '/readyz') {
        this.serveHealth(response, 'ready');
      } else if (request.method === 'POST' && url === '/rpc') {
        await this.handleRpc(request, response);
      } else if (request.method === 'GET') {
        await this.serveStatic(url, response);
      } else {
        response.writeHead(405).end('Method Not Allowed');
      }
      const status = response.statusCode;
      log.info('http.request.end', { method, url, status, ms: Date.now() - started });
    });
  }

  /** 指标端点。 */
  private serveMetrics(response: ServerResponse): void {
    const body = this.options.metrics?.toPrometheus() ?? '';
    response.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4' });
    response.end(body);
  }

  /**
   * 健康探针（`/healthz` 存活 / `/readyz` 就绪）。
   *
   * - 存活：进程能响应即视为存活，恒 200。
   * - 就绪：核心组件（`app`/`bridge`）齐备才 200，否则 **503**（容器编排据此摘流量）。
   *   `webDir`/`metrics` 是可选能力，只报诊断信息，不参与就绪判定——
   *   否则「没配 metrics」会被误判成「服务不可用」。
   */
  private serveHealth(response: ServerResponse, mode: 'live' | 'ready'): void {
    const core = {
      app: this.options.app !== undefined,
      bridge: this.options.bridge !== undefined,
    };
    const checks: Record<string, boolean> = {
      ...core,
      webDir: existsSync(this.options.webDir),
      metrics: this.options.metrics !== undefined,
    };
    const ok = mode === 'live' || Object.values(core).every(Boolean);
    const body: HealthStatus = {
      status: ok ? 'ok' : 'degraded',
      uptimeSeconds: Math.round((Date.now() - this.startedAt) / 1000),
      checks,
    };
    response.writeHead(ok ? 200 : 503, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(body));
  }

  /** SSE 长连接。 */
  private openSse(response: ServerResponse): void {
    response.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    response.write('retry: 1000\n\n');
    this.options.bridge.registerSse(response);
  }

  /** JSON-RPC 处理。 */
  private async handleRpc(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const body = await this.readBody(request);
    const authHeader =
      typeof request.headers['authorization'] === 'string'
        ? request.headers['authorization']
        : undefined;
    const result = await this.options.bridge.handlePost(body, authHeader);
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(result));
  }

  /** 静态文件（防目录穿越）。 */
  private async serveStatic(url: string, response: ServerResponse): Promise<void> {
    // 去掉 query string，让 `?v=时间戳` 这类缓存破坏参数不影响文件查找。
    const cleanUrl = url.split('?')[0] ?? url;
    const relative = cleanUrl === '/' ? 'index.html' : cleanUrl.replace(/^\//, '');
    const file = normalize(join(this.options.webDir, relative));
    if (!file.startsWith(this.options.webDir)) {
      response.writeHead(403).end('Forbidden');
      return;
    }
    try {
      const content = await readFile(file);
      response.writeHead(200, {
        'Content-Type': this.contentType(file),
        'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
        Pragma: 'no-cache',
        Expires: '0',
      });
      response.end(content);
    } catch {
      response.writeHead(404).end('Not Found');
    }
  }

  /** 读取请求体。 */
  private readBody(request: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      request.on('error', reject);
    });
  }

  /** 内容类型。 */
  private contentType(file: string): string {
    switch (extname(file)) {
      case '.html':
        return 'text/html; charset=utf-8';
      case '.js':
        return 'text/javascript; charset=utf-8';
      case '.css':
        return 'text/css; charset=utf-8';
      default:
        return 'application/octet-stream';
    }
  }
}

/** 供引用：RpcRequest 类型导出（避免未使用告警）。 */
export type { RpcRequest };
