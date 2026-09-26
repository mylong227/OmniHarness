import { HttpBridgeTransport } from './httpBridgeTransport.js';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import type { AppServer } from '../core/appServer.js';
import { type RpcRequest } from '../core/jsonRpc.js';
import { WsServer } from './wsConnection.js';
import { ServerAuthGuard } from './serverAuthGuard.js';
import type { Metrics } from '../services/metrics.js';
import { log, Logger } from '../../util/logger.js';
import { SafeFs } from '../services/safeFs.js';

/** HTTP 桥接传输：POST/WS 请求关联响应，通知广播到 SSE/WS 客户端。 */

/** HTTP 服务选项。 */
export interface HttpServerOptions {
  readonly app: AppServer;
  readonly bridge: HttpBridgeTransport;
  readonly webDir: string;
  readonly metrics?: Metrics;
  /**
   * 工作区根目录（#OBS-11）：用于 GET /files 工作区文件下载的越界校验。
   * 注入为方法而非值：AppServer 切换工作区时无需重启 HTTP 服务。
   */
  readonly workspaceRoot?: () => string;
  /**
   * 绑定地址（缺省回环 `127.0.0.1`）。
   *
   * 为什么显式给默认值：`server.listen(port)` 不传地址时 Node 会绑 `0.0.0.0`——
   * 这等于把一个能驱动 agent 执行任意工具（含 `--auto-approve`）的 RPC 暴露到局域网。
   */
  readonly host?: string | undefined;
  /** 访问令牌（配了才启用鉴权；非回环绑定必须配，见 `ServerAuthGuard.assertBindSafe`）。 */
  readonly authToken?: string | undefined;
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
  /**
   * 请求体总量上限（字节）：8 MiB。
   *
   * 依据：本服务的请求体只有 JSON-RPC 帧与 `/attach` 载荷两类，正常量级为 KB；8 MiB 给
   * 附件类请求留足余量，同时把「不封口的 POST 吃光内存」这条 OOM 路径彻底封死。
   */
  public static readonly MAX_BODY_BYTES = 8 * 1024 * 1024;

  /** node:http 原生服务器实例（承载静态页 / RPC / SSE / WS 升级）。 */
  private readonly server: Server;
  /** WS 服务端：close 时须先强制断开 upgrade 连接，否则 server.close 永不回调。 */
  private readonly ws: WsServer;
  /** 暴露守卫：绑定地址与 Bearer 令牌的唯一裁决点（HTTP 与 WS 共用）。 */
  private readonly guard: ServerAuthGuard;
  /** 启动时刻（用于 uptime，构造即计时）。 */
  private readonly startedAt = Date.now();

  /**
   * 创建 HTTP 服务：装配请求路由与 WS 升级处理。
   * @param options 服务选项（app、bridge、webDir、metrics、workspaceRoot、host、authToken），同时作为参数属性持有为实例字段
   */
  public constructor(private readonly options: HttpServerOptions) {
    this.guard = new ServerAuthGuard(options.authToken);
    // 路由是异步的：浮动 Promise 一旦抛出（例如 readBody 后的解析异常），既不会写出响应，
    // 也会变成 unhandledRejection —— Node 22 默认**终止进程**（2026-09-26 审计 S21）。
    // 这里统一收口：写一次 500（若尚未写出）并记结构化日志，进程不受影响。
    this.server = createServer((request, response) => {
      void this.route(request, response).catch((error: unknown) => {
        log.warn('http.route.failed', {
          url: request.url ?? '',
          method: request.method ?? '',
          error: error instanceof Error ? error.message : String(error),
        });
        if (!response.headersSent) {
          response.writeHead(500, { 'content-type': 'application/json' });
        }
        if (!response.writableEnded) {
          response.end(JSON.stringify({ error: 'internal' }));
        }
      });
    });
    this.ws = new WsServer(
      this.server,
      (connection) => this.options.bridge.registerWs(connection),
      (request) => this.guard.verify(request),
    );
  }

  /**
   * 启动并返回端口。
   * @param port 期望监听的端口（0 表示由操作系统分配）
   * @returns 实际生效的监听端口（port 为 0 时是系统分配值）
   */
  public start(port: number): Promise<number> {
    return new Promise((resolve, reject) => {
      const host = this.options.host ?? ServerAuthGuard.DEFAULT_HOST;
      try {
        // 起服务前先过绑定安全裁决：非回环且无令牌 → 直接拒绝（fail-closed，不起半个服务）。
        ServerAuthGuard.assertBindSafe(host, this.options.authToken);
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      // 监听失败（EADDRINUSE / EACCES）不走 listen 回调，而是把 'error' 事件抛到该 Server
      // 对象上——**无人监听时它就是 uncaughtException（进程直接死）**，同时 start() 的 Promise
      // 永不 settle（调用方连报错的机会都没有）。故必须显式接一次并 reject；监听成功后立刻摘下，
      // 免得留一个长期吞掉后续 'error' 的监听器。
      const onListenError = (error: Error): void => reject(error);
      this.server.once('error', onListenError);
      this.server.listen(port, host, () => {
        this.server.removeListener('error', onListenError);
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
   * @returns 监听关闭后 resolve，无载荷
   */
  public close(): Promise<void> {
    return new Promise((resolve) => {
      this.ws.closeAll();
      this.server.closeAllConnections?.();
      this.server.close(() => resolve());
    });
  }

  /** 路由。每条请求建独立 traceId，全程日志自动携带，便于跨调用串联。
   * @param request 原始 HTTP 请求（方法 + URL 决定分支）
   * @param response 响应对象（各分支直接写头写体后 end）
   * @returns 本请求处理完毕（含异步 RPC / 文件读取）后 resolve，无载荷
   */
  private async route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = request.url ?? '/';
    const traceId = Logger.nextTraceId(
      typeof request.headers['x-trace-id'] === 'string' ? request.headers['x-trace-id'] : undefined,
    );
    await log.withTrace(traceId, async () => {
      const started = Date.now();
      const method = request.method ?? 'GET';
      log.info('http.request.start', { method, url });
      if (!this.guard.verify(request)) {
        // 鉴权门禁（配令牌时生效）：401 + WWW-Authenticate，让客户端知道该怎么补头。
        response.writeHead(401, {
          'content-type': 'application/json; charset=utf-8',
          'www-authenticate': 'Bearer',
        });
        response.end(JSON.stringify({ error: 'unauthorized' }));
        return;
      }
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
      } else if (request.method === 'GET' && url.startsWith('/files')) {
        // #OBS-11：工作区文件下载（Agent 写出的产物、前端 artifact 卡片 download 走这里）。
        // 路径校验与 RPC fs.read 共用 safeReadFile，fail-closed 越界/缺失统一 403/404。
        await this.serveWorkspaceFile(url, response);
      } else if (request.method === 'GET') {
        await this.serveStatic(url, response);
      } else {
        response.writeHead(405).end('Method Not Allowed');
      }
      const status = response.statusCode;
      log.info('http.request.end', { method, url, status, ms: Date.now() - started });
    });
  }

  /**
   * 指标端点。
   * @param response 响应对象（Prometheus 文本格式写出）
   * @returns 无返回值。
   */
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
   * @param response 响应对象（JSON 状态体 + 200/503 状态码）
   * @param mode `'live'` 存活探针（恒 200）| `'ready'` 就绪探针（核心组件齐备才 200）
   * @returns 无返回值。
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

  /**
   * SSE 长连接。
   * @param response 响应对象（切换为 event-stream 后交给 bridge 注册广播）
   * @returns 无返回值。
   */
  private openSse(response: ServerResponse): void {
    response.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    response.write('retry: 1000\n\n');
    this.options.bridge.registerSse(response);
  }

  /**
   * JSON-RPC 处理。
   * @param request POST /rpc 请求（读取完整请求体）
   * @param response 响应对象（JSON 序列化的 RPC 结果）
   * @returns 响应写出完成后 resolve，无载荷
   */
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

  /**
   * 静态文件（防目录穿越）。
   * @param url 请求 URL（映射到 webDir 下相对路径，`/` 回退 index.html）
   * @param response 响应对象（命中 200 返回文件内容，越界 403，缺失 404）
   * @returns 响应写出完成后 resolve，无载荷
   */
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

  /**
   * 工作区文件下载（#OBS-11）：GET /files?path=<rel>，路径越界/缺失统一 403/404。
   * 复用 safeReadFile（与 RPC fs.read 同一套安全逻辑），force-download 用 Content-Disposition。
   * @param url 请求 URL（query 中的 path 为工作区相对路径）
   * @param response 响应对象（以附件形式返回文件内容）
   * @returns 响应写出完成后 resolve，无载荷
   */
  private async serveWorkspaceFile(url: string, response: ServerResponse): Promise<void> {
    const ws = this.options.workspaceRoot?.();
    if (ws === undefined || ws === '') {
      response.writeHead(503).end('工作区未配置');
      return;
    }
    const queryStart = url.indexOf('?');
    if (queryStart === -1) {
      response.writeHead(400).end('缺少 path 查询参数');
      return;
    }
    const params = new URLSearchParams(url.slice(queryStart + 1));
    const rel = params.get('path');
    if (rel === null || rel === '') {
      response.writeHead(400).end('缺少 path 查询参数');
      return;
    }
    let decoded: string;
    try {
      decoded = decodeURIComponent(rel);
    } catch {
      response.writeHead(400).end('path 解码失败');
      return;
    }
    const r = SafeFs.safeReadFile(ws, decoded);
    if (!r.ok) {
      // 越界/缺失：403/404 区分；其他错误统一 500。
      const status =
        r.error === '路径越界工作区' ? 403 : r.error.startsWith('读取失败') ? 404 : 500;
      response.writeHead(status).end(r.error);
      return;
    }
    const fileName = decoded.split(/[\\/]/).pop() || 'download';
    // RFC 5987 中文/特殊字符文件名：用 ASCII 兜底 + utf-8 编码（浏览器双解析时取 utf-8）。
    const encoded = encodeURIComponent(fileName);
    response.writeHead(200, {
      'Content-Type': this.contentType(decoded) || 'application/octet-stream',
      'Content-Length': String(r.size),
      'Content-Disposition': `attachment; filename="${fileName.replace(/[\r\n"]/g, '_')}"; filename*=UTF-8''${encoded}`,
      'Cache-Control': 'no-store',
    });
    response.end(r.buffer);
  }

  /**
   * 读取请求体（带**总量上限**）。
   *
   * 为什么要上限（2026-09-26 审计 S21）：原实现无界累积分块，一个不封口的 POST 就能把
   * 服务端内存吃光（OOM），而请求体在上限内本应是小 JSON。超限即销毁连接（fail-closed），
   * 不再等对端把余下字节吐完。
   * @param request 请求流（收集 data 分块直到 end）
   * @returns 完整请求体的 UTF-8 字符串
   */
  private readBody(request: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      request.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > HttpServer.MAX_BODY_BYTES) {
          // 先拒后断：让调用方拿到明确的「请求体过大」，而不是一个连接重置。
          request.destroy();
          reject(new Error(`请求体超过上限 ${String(HttpServer.MAX_BODY_BYTES)} 字节`));
          return;
        }
        chunks.push(chunk);
      });
      request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      request.on('error', reject);
    });
  }

  /**
   * 内容类型。
   * @param file 文件路径（按扩展名判定）
   * @returns 对应 MIME 类型；未识别扩展名回退 application/octet-stream
   */
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
export { HttpBridgeTransport };
