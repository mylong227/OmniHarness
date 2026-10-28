import http from 'node:http';
import { Id } from '../util/id.ts';
import { ServerAuthGuard } from '../server/transport/serverAuthGuard.ts';
import { AgUiEventStream } from './aguiEventStream.ts';
import type {
  AgUiAgentRunner,
  AgUiEvent,
  AgUiHttpServerOptions,
  AgUiRunInput,
} from './aguiProtocol.ts';

/** 默认请求体上限（1 MiB）。 */
const DEFAULT_MAX_BODY_BYTES = 1_048_576;
/** 读请求体超时（毫秒）。 */
const READ_TIMEOUT_MS = 30_000;

/** 可接受的 AG-UI 运行路径（`/agui` 为简写，`/agui/run` 为规范式）。 */
const RUN_PATHS: ReadonlySet<string> = new Set<string>(['/agui', '/agui/run']);

/** 免鉴权探活路径（只回协议标识，不含任何会话/工作区数据）。 */
const HEALTH_PATH = '/agui/health';

/**
 * AG-UI HTTP/SSE 适配端点（**独立于现有 Web RPC/SSE，不改前端**）。
 *
 * - `POST /agui` / `POST /agui/run`：body 为 `AgUiRunInput`，响应为 `text/event-stream`，
 *   每行 `data: <AgUiEvent JSON>`，以 `RUN_FINISHED` 或 `RUN_ERROR` 收尾。
 * - `GET /agui/health`：探活（免鉴权，只回协议标识）。
 *
 * 运行器由调用方注入（`createRuntime` + `Agent` 的薄包装在组合层完成），本类只负责
 * HTTP 语义、取消传播与 SSE 编码。
 *
 * ## 暴露面纪律（2026-10-27 审计收口，与主 serve 同一套规则）
 *
 * 本端点能驱动 agent 执行任意工具 ⇒ 复用主服务的 `ServerAuthGuard`：
 *  1. 默认只绑回环；**非回环绑定必须配令牌**，否则拒绝启动（fail-closed）；
 *  2. 除探活外一律要求 `Authorization: Bearer <token>`（或 `?token=`）；
 *  3. 带 `Origin` 的浏览器请求必须来自回环页面——任意网页都能向 127.0.0.1 发请求，
 *     CORS 通配（`*`）等于把「驱动 agent」暴露给互联网内容，已移除；仅回环 Origin 回显。
 * 令牌取 `options.token`，缺省回落 `OMNI_SERVE_TOKEN` 环境变量（与主 serve 共用一把钥匙）。
 */
export class AgUiHttpServer {
  /** 运行器。 */
  private readonly run: AgUiAgentRunner;
  /** 监听地址。 */
  private readonly host: string;
  /** 请求体上限（字节）。 */
  private readonly maxBodyBytes: number;
  /** 暴露守卫（令牌鉴权 + Origin 回环校验）。 */
  private readonly guard: ServerAuthGuard;
  /** 底层 HTTP 服务（listen 后才有值）。 */
  private server: http.Server | undefined;
  /** 在飞的 run 取消器（close() 时逐个 abort，保证「已关闭 ⇒ 不再烧 token」）。 */
  private readonly activeRuns = new Set<AbortController>();

  /**
   * @param options 运行器与可选监听/体积/令牌配置。
   */
  public constructor(options: AgUiHttpServerOptions) {
    this.run = options.run;
    this.host = options.host ?? '127.0.0.1';
    this.maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
    const token = (options.token ?? process.env[ServerAuthGuard.TOKEN_ENV] ?? '').trim();
    this.guard = new ServerAuthGuard(token);
  }

  /**
   * 在给定端口监听。
   * @param port 端口（0 = 系统分配）。
   * @returns 实际监听端口。
   * @throws 非回环绑定且未配令牌时拒绝启动（fail-closed）；端口占用等 listen 错误原样上抛。
   */
  public async listen(port: number): Promise<number> {
    ServerAuthGuard.assertBindSafe(this.host, this.guard.enabled ? 'configured' : undefined);
    const server = http.createServer((req, res) => {
      res.on('error', () => {
        // 客户端提前断开（RST/半关闭）时写响应会触发 'error'；Node 22 默认会把无监听的
        // response error 升级为 uncaughtException 终止进程（httpServer.ts 同一课的此处补齐）。
      });
      void this.handleRequest(req, res);
    });
    this.server = server;
    return await new Promise<number>((resolve, reject) => {
      const onError = (error: Error): void => {
        reject(error);
      };
      server.once('error', onError);
      server.listen(port, this.host, () => {
        server.off('error', onError);
        const address = server.address();
        resolve(typeof address === 'object' && address !== null ? address.port : port);
      });
    });
  }

  /**
   * 关闭监听并 abort 全部在飞 run。
   *
   * 此前实现只 `server.close()`：会等活跃 SSE 连接自然结束，调用方以为已停止、
   * 在跑的 Agent 回合仍在烧 token 且进程退不出去（与 `AppServer.shutdown` 的口径对齐）。
   * @returns 无返回值。
   */
  public close(): void {
    for (const controller of this.activeRuns) {
      controller.abort();
    }
    this.activeRuns.clear();
    // 空闲 keep-alive 立即断；在飞 SSE 连接由上面的 abort 驱动其自然收尾（res.end），
    // 不用 closeAllConnections 硬撕——那会在尾字节写出前掐断 socket。
    this.server?.closeIdleConnections();
    this.server?.close();
    this.server = undefined;
  }

  /**
   * 处理单条 HTTP 请求（鉴权 + 路由 + CORS + 预检）。
   * @param req 入站请求。
   * @param res 响应对象。
   * @returns 处理完成。
   */
  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    // 路由按纯路径匹配（查询串不参与；鉴权走 guard.verify 读完整 url 的 ?token=）。
    const path = (req.url ?? '').split('?')[0] ?? '';
    if (req.method === 'OPTIONS') {
      AgUiHttpServer.writeCors(res, req);
      res.writeHead(204);
      res.end();
      return;
    }
    if (req.method === 'GET' && path === HEALTH_PATH) {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, protocol: 'ag-ui' }));
      return;
    }
    if (req.method !== 'POST' || !RUN_PATHS.has(path)) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('not found');
      return;
    }
    // 运行路径是唯一的敏感面：令牌鉴权 + 浏览器 Origin 回环校验（探活不校验）。
    if (!this.guard.verify(req)) {
      res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('unauthorized: 需要 Bearer 令牌（或 ?token=），且 Origin 必须来自回环页面');
      return;
    }
    const body = await this.readBody(req, res);
    if (body === undefined) return;
    let input: AgUiRunInput;
    try {
      const parsed: unknown = JSON.parse(body);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new Error('body 必须是 JSON 对象');
      }
      input = parsed as AgUiRunInput;
    } catch (error) {
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(`invalid body: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    await this.streamRun(input, req, res);
  }

  /**
   * 执行一次 run 并以 SSE 回写 AG-UI 事件。
   * @param input 运行输入。
   * @param req 入站请求（断开 → 取消）。
   * @param res 响应对象。
   * @returns 流结束。
   */
  private async streamRun(
    input: AgUiRunInput,
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const threadId = typeof input.threadId === 'string' ? input.threadId : Id.id('thread');
    const runId = typeof input.runId === 'string' ? input.runId : Id.id('run');
    const controller = new AbortController();
    this.activeRuns.add(controller);
    req.on('close', () => controller.abort());
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
      ...AgUiHttpServer.corsOrigin(req),
    });
    res.flushHeaders();
    const messages = Array.isArray(input.messages) ? input.messages : undefined;
    // 2026-10-29：input.state 此前被忽略；非空对象作为首个 STATE_SNAPSHOT 下发（恢复语义）。
    const initialState =
      typeof input.state === 'object' && input.state !== null && !Array.isArray(input.state)
        ? (input.state as Readonly<Record<string, unknown>>)
        : undefined;
    const stream = new AgUiEventStream({
      threadId,
      runId,
      messages,
      ...(initialState !== undefined ? { initialState } : {}),
    });
    try {
      const events = this.run(input, controller.signal);
      for await (const event of stream.run(events, controller.signal)) {
        AgUiHttpServer.writeSse(res, event);
      }
    } catch (error) {
      AgUiHttpServer.writeSse(res, {
        type: 'RUN_ERROR',
        message: error instanceof Error ? error.message : String(error),
        code: 'RUN_ERROR',
        timestamp: Date.now(),
      });
    } finally {
      this.activeRuns.delete(controller);
      if (!res.writableEnded) res.end();
    }
  }

  /**
   * 读取请求体（体积上限 + 读超时，超限返回 413 并 resolve undefined）。
   * @param req 入站请求。
   * @param res 响应对象。
   * @returns 请求体文本；失败/超限为 undefined。
   */
  private async readBody(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<string | undefined> {
    return await new Promise<string | undefined>((resolve) => {
      const chunks: Buffer[] = [];
      let received = 0;
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        res.writeHead(408, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('read timeout');
        resolve(undefined);
      }, READ_TIMEOUT_MS);
      const finish = (value: string | undefined): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      };
      req.on('data', (chunk: Buffer) => {
        if (settled) return;
        received += chunk.length;
        if (received > this.maxBodyBytes) {
          res.writeHead(413, { 'content-type': 'text/plain; charset=utf-8' });
          res.end('body too large');
          req.resume();
          finish(undefined);
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => finish(Buffer.concat(chunks).toString('utf8')));
      req.on('error', () => finish(undefined));
    });
  }

  /**
   * 写一条 SSE 事件。
   * @param res 响应对象。
   * @param event AG-UI 事件。
   * @returns 无返回值。
   */
  private static writeSse(res: http.ServerResponse, event: AgUiEvent): void {
    if (res.writableEnded) return;
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  }

  /**
   * 计算 SSE 响应的 CORS 回显头（仅回环 Origin；外部 Origin 一律不给 allow-origin，
   * 防「任意网页跨源读取 agent 输出」）。
   * @param req 入站请求。
   * @returns 可展开进 writeHead 的头（无跨源时为空对象）。
   */
  private static corsOrigin(req: http.IncomingMessage): Record<string, string> {
    const origin = req.headers['origin'];
    if (typeof origin !== 'string' || origin === '') return {};
    try {
      const url = new URL(origin);
      if (
        (url.protocol === 'http:' || url.protocol === 'https:') &&
        ServerAuthGuard.isLoopback(url.hostname)
      ) {
        return { 'access-control-allow-origin': origin };
      }
    } catch {
      // 非法 Origin：不回显。
    }
    return {};
  }

  /**
   * 写 CORS 预检响应头（仅回环 Origin 回显；外部 Origin 不给任何跨源许可）。
   * @param res 响应对象。
   * @param req 入站请求（读 Origin）。
   * @returns 无返回值。
   */
  private static writeCors(res: http.ServerResponse, req: http.IncomingMessage): void {
    const origin = AgUiHttpServer.corsOrigin(req);
    if (origin['access-control-allow-origin'] === undefined) return;
    res.setHeader('access-control-allow-origin', origin['access-control-allow-origin']);
    res.setHeader('access-control-allow-methods', 'POST, GET, OPTIONS');
    res.setHeader('access-control-allow-headers', 'content-type, authorization');
  }
}
