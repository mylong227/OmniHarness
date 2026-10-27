/**
 * MCP 2026-07-28 **Streamable HTTP** 服务端路由（零依赖，基于 `node:http`）。
 *
 * 本类把 {@link McpServer} 的 JSON-RPC 能力暴露到 HTTP：
 *  - `POST`：读 body（1 MiB 上限 + 读超时）→ 解析单条/批量 JSON-RPC → 校验
 *    `MCP-Protocol-Version` / `Mcp-Method` / `Mcp-Name` 与请求体一致 → 分发；
 *    普通请求回 `application/json`，`subscriptions/listen` 回 `text/event-stream` 长流；
 *  - `GET`：健康/能力自述（便于探活与人工核对端点）；
 *  - `OPTIONS`：CORS 预检；
 *  - 其它方法：`405` + `Allow`。
 *
 * 长生命周期响应流复用 {@link McpSseResponseTransport}：它按原始 JSON-RPC id 把
 * ack/通知/完成响应写入**发起 listen 的那条 POST**，本类只负责 socket 写入与断开注销。
 *
 * 配置归一化、头一致性校验与 CORS 等纯函数在 `mcpHttpSupport.ts`；本文件只保留
 * 「HTTP 路由 + socket 生命周期 + 响应写出」，以守住单文件/单类体量阈值。
 *
 * 错误口径（HTTP 状态 + JSON-RPC error）：
 *  - `400`：JSON 解析失败（`-32700`）、请求信封非法/头不一致（`-32020`）、版本不支持（`-32022`）；
 *  - `406`：`Accept` 不允许所需响应类型；
 *  - `413`：请求体超过上限（默认 1 MiB）；
 *  - `415`：`Content-Type` 不是 `application/json`；
 *  - `408`：读取请求体超时；
 *  - `200`：服务端已分发的 JSON-RPC 错误（如 `-32602` / `-32601` / 工具 `isError`）。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { McpServerInfo } from '../ports/mcp/mcpProtocolTypes.ts';
import type { RequestId } from '../ports/server/requestId.ts';
import { jsonRpc, type RpcMessage, type RpcRequest } from '../server/core/jsonRpc.ts';
import { ServerAuthGuard } from '../server/transport/serverAuthGuard.ts';
import { log } from '../util/logger.ts';
import { McpProtocol } from './mcpProtocol.ts';
import { McpServer, type McpServerOptions } from './mcpServer.ts';
import { McpSseResponseTransport } from './mcpSseResponseTransport.ts';
import {
  acceptsMediaType,
  applyCorsHeaders,
  headerMismatchOf,
  headerText,
  isJsonContentType,
  isListenRequest,
  listenAddressOf,
  listenFailureOf,
  matchesHttpPath,
  metaVersionOf,
  normalizeHttpConfig,
  normalizeHttpMessages,
  statusOfRpcMessage,
  type McpHttpListenAddress,
  type McpHttpServerConfig,
  type NormalizedHttpConfig,
} from './mcpHttpSupport.ts';

/** JSON-RPC 解析错误码。 */
const ERROR_PARSE = -32700;
/** JSON-RPC 请求信封非法。 */
const ERROR_INVALID_REQUEST = -32600;
/** 读取请求体超时的 HTTP 状态码。 */
const HTTP_TIMEOUT = 408;

/**
 * HTTP 服务端选项：与 {@link McpServerOptions} 相同，只是 `transport` 由本类装配。
 */
export type McpHttpServerOptions = Omit<McpServerOptions, 'transport'>;

// 配置/监听地址契约在支撑层定义，这里再导出以维持「从 McpHttpServer 模块取类型」的 API 面。
export type { McpHttpServerConfig, McpHttpListenAddress } from './mcpHttpSupport.ts';

/** 已解析的 HTTP 请求体。 */
interface ParsedHttpBody {
  /** 归一化后的 JSON-RPC 消息。 */
  readonly messages: readonly RpcMessage[];
  /** 是否为批量数组。 */
  readonly batch: boolean;
}

/**
 * 请求体读取失败（带建议的 HTTP 状态码）。
 *
 * 用类而非裸 Error：调用点要区分「超限 413 / 超时 408 / 其它 400」，字符串匹配不可靠。
 */
class McpHttpBodyError extends Error {
  /** 建议的 HTTP 状态码。 */
  public readonly status: number;

  /**
   * @param message 可读原因。
   * @param status 建议的 HTTP 状态码。
   */
  public constructor(message: string, status: number) {
    super(message);
    this.name = 'McpHttpBodyError';
    this.status = status;
  }
}

/** 错误消息提取。 */
const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * @beta
 * MCP Streamable HTTP 服务端：组合 `node:http` + {@link McpSseResponseTransport} + {@link McpServer}。
 *
 * 一个实例对应一个端点（默认 `/mcp`）；`listen()` 可重复调用（已监听时直接回报地址），
 * `close()` 幂等且会先优雅结束全部 `subscriptions/listen` 流再关 socket。
 */
export class McpHttpServer {
  /** 归一化监听配置。 */
  private readonly config: NormalizedHttpConfig;
  /** 对外上报的服务端信息（GET 健康与 McpServer 共用）。 */
  private readonly info: McpServerInfo;
  /** 底层 MCP 服务端（宿主可经此发布订阅通知）。 */
  public readonly mcp: McpServer;
  /** 按 POST 请求分流的 SSE 传输。 */
  private readonly transport: McpSseResponseTransport;
  /** node:http 服务器实例。 */
  private readonly http: Server;
  /** 活跃的 SSE 响应（键为 `subscriptions/listen` 的请求 id）。 */
  private readonly sse = new Map<RequestId, ServerResponse>();
  /** `close()` 的幂等缓存。 */
  private closePromise: Promise<void> | undefined;
  /** 暴露守卫（Bearer 令牌鉴权；配置了令牌时全端点生效）。 */
  private readonly guard: ServerAuthGuard;
  /** 服务端响应流唯一键序列（防客户端 id 复用导致响应串线）。 */
  private streamSeq = 0;

  /**
   * @param options MCP 服务端选项（tools/context/gate/resources/prompts/extensions/cache/inputRequired）。
   * @param config 监听配置（host/port/path 与可选上限/令牌；令牌缺省回落 `OMNI_SERVE_TOKEN`）。
   */
  public constructor(options: McpHttpServerOptions, config: McpHttpServerConfig) {
    // 令牌的环境回落只在构造期解析一次；normalizeHttpConfig 保持纯函数。
    this.config = normalizeHttpConfig({
      ...config,
      token: config.token ?? process.env[ServerAuthGuard.TOKEN_ENV] ?? '',
    });
    this.info = options.serverInfo ?? { name: 'omniharness', version: '0.1.0' };
    this.guard = new ServerAuthGuard(this.config.token);
    this.transport = new McpSseResponseTransport((frame) => {
      log.warn('mcp.http.unrouted', { event: frame.event });
    });
    this.mcp = new McpServer({ ...options, transport: this.transport });
    this.http = createServer((request, response) => {
      response.on('error', () => {
        // 客户端提前断开时写响应会触发 'error'；无监听会被 Node 22 升级为
        // uncaughtException 终止进程（httpServer.ts 的同一课）。写失败伴随连接死亡，无需上报。
      });
      void this.handle(request, response);
    });
  }

  /**
   * 启动 HTTP 监听（端口 0 由内核分配）。
   * @returns 实际监听地址（`port` 为真实端口）。
   * @throws Error 非回环绑定且未配令牌时拒绝启动（fail-closed）；监听失败（端口占用/权限/地址不可用）时抛出可行动消息。
   */
  public async listen(): Promise<McpHttpListenAddress> {
    ServerAuthGuard.assertBindSafe(this.config.host, this.config.token || undefined);
    if (this.http.listening) {
      return Promise.resolve(listenAddressOf(this.http, this.config.host));
    }
    return new Promise<McpHttpListenAddress>((resolve, reject) => {
      const cleanup = (): void => {
        this.http.off('error', onError);
        this.http.off('listening', onListening);
      };
      const onError = (error: unknown): void => {
        cleanup();
        reject(listenFailureOf(this.config, error));
      };
      const onListening = (): void => {
        cleanup();
        resolve(listenAddressOf(this.http, this.config.host));
      };
      this.http.once('error', onError);
      this.http.once('listening', onListening);
      try {
        this.http.listen(this.config.port, this.config.host);
      } catch (error) {
        cleanup();
        reject(listenFailureOf(this.config, error));
      }
    });
  }

  /**
   * 关闭服务：先结束全部订阅流（发完成响应），再关 HTTP 服务器。幂等。
   * @returns 关闭完成的 Promise。
   */
  public close(): Promise<void> {
    this.closePromise ??= this.shutdown();
    return this.closePromise;
  }

  /**
   * 请求入口：路径/方法路由 + 顶层异常兜底。
   * @param request 入站请求。
   * @param response 响应对象。
   * @returns 无返回值。
   */
  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      applyCorsHeaders(response, this.config.corsOrigin, headerText(request, 'origin'));
      // 令牌鉴权（2026-10-27 审计收口）：配置了令牌时**所有**方法（含健康/预检）都要求
      // Bearer/`?token=`；未配置令牌时仅回环绑定为默认形态（非回环已在 listen() 拒绝）。
      if (this.guard.enabled && !this.guard.verify(request)) {
        this.respondError(
          response,
          401,
          ERROR_INVALID_REQUEST,
          'unauthorized：需要 Authorization: Bearer <token>（或 ?token=）',
        );
        return;
      }
      const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
      if (!matchesHttpPath(url.pathname, this.config.path)) {
        this.respondError(
          response,
          404,
          McpProtocol.ERROR_INVALID_PARAMS,
          `未知路径：${url.pathname}（MCP 端点为 ${this.config.path}）`,
        );
        return;
      }
      if (request.method === 'OPTIONS') {
        this.respondOptions(response);
        return;
      }
      if (request.method === 'GET') {
        this.respondHealth(response);
        return;
      }
      if (request.method !== 'POST') {
        response.setHeader('Allow', 'GET, POST, OPTIONS');
        this.respondError(
          response,
          405,
          McpProtocol.ERROR_INVALID_PARAMS,
          `不支持的 HTTP 方法：${request.method ?? '未知'}`,
        );
        return;
      }
      await this.handlePost(request, response);
    } catch (error) {
      log.warn('mcp.http.request_failed', { message: messageOf(error) });
      if (!response.headersSent) {
        this.respondError(response, 500, McpProtocol.ERROR_INTERNAL, 'MCP HTTP 内部错误');
      } else if (!response.writableEnded) {
        response.end();
      }
    }
  }

  /**
   * CORS 预检：`204` + 允许方法/头（头已由 `applyCorsHeaders` 写入）。
   * @param response 响应对象。
   * @returns 无返回值。
   */
  private respondOptions(response: ServerResponse): void {
    response.statusCode = 204;
    response.end();
  }

  /**
   * `GET` 健康/能力自述（不承载 JSON-RPC，只用于探活与人工核对）。
   * @param response 响应对象。
   * @returns 无返回值。
   */
  private respondHealth(response: ServerResponse): void {
    this.respondJson(response, 200, {
      status: 'ok',
      transport: 'streamable-http',
      serverInfo: this.info,
      protocolVersions: [...McpProtocol.SUPPORTED_VERSIONS],
      endpoint: this.config.path,
    });
  }

  /**
   * `POST` 主流程：预检 → 读/解析 body → 头一致性 → 分发或 SSE。
   * @param request 入站请求。
   * @param response 响应对象。
   * @returns 无返回值。
   */
  private async handlePost(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!this.preflightMedia(request, response)) return;
    const accept = headerText(request, 'accept');
    const body = await this.readJsonBody(request, response);
    if (body === undefined) return;
    const mismatch = headerMismatchOf(request, body.messages, body.batch);
    if (mismatch !== undefined) {
      this.respondError(response, 400, mismatch.code, mismatch.message, mismatch.data);
      return;
    }
    const first = body.messages[0];
    if (!body.batch && first !== undefined && isListenRequest(first)) {
      if (metaVersionOf(first) === undefined) {
        this.respondError(
          response,
          400,
          McpProtocol.ERROR_INVALID_PARAMS,
          'subscriptions/listen 需要 2026-07-28 每请求 _meta',
        );
        return;
      }
      if (!acceptsMediaType(accept, 'text/event-stream')) {
        this.respondError(
          response,
          406,
          ERROR_INVALID_REQUEST,
          'subscriptions/listen 要求 Accept 允许 text/event-stream',
        );
        return;
      }
      await this.handleListen(response, first);
      return;
    }
    const replies = await this.dispatchAll(body.messages);
    if (replies.length === 0) {
      response.statusCode = 202;
      response.end();
      return;
    }
    const single = body.batch ? undefined : replies[0];
    this.respondJson(
      response,
      single === undefined ? 200 : statusOfRpcMessage(single),
      body.batch ? replies : single,
    );
  }

  /**
   * 媒体类型/接受类型/声明体积的快速预检（失败时已回 4xx 并返回 false）。
   * @param request 入站请求。
   * @param response 响应对象。
   * @returns 预检通过为 true。
   */
  private preflightMedia(request: IncomingMessage, response: ServerResponse): boolean {
    if (!isJsonContentType(headerText(request, 'content-type'))) {
      this.respondError(
        response,
        415,
        ERROR_INVALID_REQUEST,
        'Content-Type 必须是 application/json',
      );
      return false;
    }
    const accept = headerText(request, 'accept');
    if (
      !acceptsMediaType(accept, 'application/json') &&
      !acceptsMediaType(accept, 'text/event-stream')
    ) {
      this.respondError(
        response,
        406,
        ERROR_INVALID_REQUEST,
        'Accept 必须允许 application/json 或 text/event-stream',
      );
      return false;
    }
    const declared = Number(headerText(request, 'content-length'));
    if (Number.isFinite(declared) && declared > this.config.bodyLimitBytes) {
      request.resume();
      this.respondError(
        response,
        413,
        ERROR_INVALID_REQUEST,
        `请求体超过 ${this.config.bodyLimitBytes} 字节上限`,
      );
      return false;
    }
    return true;
  }

  /**
   * 读取并解析 JSON-RPC 请求体（失败时已回 4xx 并返回 undefined）。
   * @param request 入站请求。
   * @param response 响应对象。
   * @returns 归一化消息与是否批量。
   */
  private async readJsonBody(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<ParsedHttpBody | undefined> {
    let raw: string;
    try {
      raw = await this.readBody(request);
    } catch (error) {
      const failure =
        error instanceof McpHttpBodyError ? error : new McpHttpBodyError(messageOf(error), 400);
      this.respondError(response, failure.status, ERROR_INVALID_REQUEST, failure.message);
      return undefined;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      this.respondError(response, 400, ERROR_PARSE, '无法解析 JSON 请求体');
      return undefined;
    }
    const messages = normalizeHttpMessages(parsed);
    if (messages === undefined) {
      this.respondError(
        response,
        400,
        ERROR_INVALID_REQUEST,
        '请求体必须是合法的 JSON-RPC 请求、通知或非空批量数组',
      );
      return undefined;
    }
    const batch = Array.isArray(parsed);
    if (batch && messages.some((message) => isListenRequest(message))) {
      this.respondError(
        response,
        400,
        ERROR_INVALID_REQUEST,
        'subscriptions/listen 必须是单独请求，不能放进批量数组',
      );
      return undefined;
    }
    return { messages, batch };
  }

  /**
   * 建立 `subscriptions/listen` 的 SSE 长流：写头 → 登记流 → 投递请求 → 保持连接。
   * @param response 响应对象。
   * @param message listen 请求。
   * @returns 无返回值（连接保持到完成响应或客户端断开）。
   */
  private async handleListen(response: ServerResponse, message: RpcRequest): Promise<void> {
    const id = message.id;
    // 订阅流按协议语义必须以客户端请求 id 为 subscriptionId 路由 ⇒ 无法像普通请求那样
    // 改写成服务端唯一键。同 id 并发订阅时**拒绝后者**（fail-closed）：静默覆盖会让前一条
    // 订阅的帧写进后一条连接。唯一 id 的客户端（正常形态）不受影响；要彻底解耦需
    // 每连接一个 transport，已登记为后续重构项。
    if (this.sse.has(id)) {
      this.respondError(
        response,
        409,
        ERROR_INVALID_REQUEST,
        `subscriptions/listen 的请求 id ${String(id)} 已有活跃订阅：请为每条订阅使用唯一 id`,
      );
      return;
    }
    response.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    response.flushHeaders();
    let finished = false;
    const finish = (): void => {
      if (finished) return;
      finished = true;
      this.sse.delete(id);
      this.transport.unregisterStream(id);
      if (!response.writableEnded) response.end();
    };
    this.transport.registerStream(id, (frame) => {
      if (finished || response.writableEnded) return;
      response.write(McpSseResponseTransport.encode(frame));
      const parsed = jsonRpc.parse(frame.data);
      if (parsed !== undefined && 'id' in parsed && !('method' in parsed)) {
        finish();
      }
    });
    this.sse.set(id, response);
    response.on('close', () => {
      if (finished) return;
      finished = true;
      this.sse.delete(id);
      this.transport.unregisterStream(id);
      this.transport.deliver({
        jsonrpc: '2.0',
        method: McpProtocol.NOTIFICATION_CANCELLED,
        params: { requestId: id },
      });
    });
    try {
      await this.mcp.handle(message);
    } catch (error) {
      log.warn('mcp.http.listen_failed', { message: messageOf(error) });
      const data = JSON.stringify({
        jsonrpc: '2.0',
        id,
        error: { code: McpProtocol.ERROR_INTERNAL, message: messageOf(error) },
      });
      if (!response.writableEnded) response.write(McpSseResponseTransport.encode({ data }));
      finish();
    }
  }

  /**
   * 顺序分发一批消息（保证批量响应顺序与请求一致）。
   * @param messages 入站消息。
   * @returns 有响应的消息（通知不产生响应）。
   */
  private async dispatchAll(messages: readonly RpcMessage[]): Promise<readonly RpcMessage[]> {
    const replies: RpcMessage[] = [];
    for (const message of messages) {
      const reply = await this.dispatchOne(message);
      if (reply !== undefined) replies.push(reply);
    }
    return replies;
  }

  /**
   * 分发单条消息：请求登记临时响应流并等待服务端写完；通知直接投递。
   *
   * **服务端唯一键（2026-10-27 审计收口）**：响应流按**服务端生成的唯一键**登记，
   * 请求 id 在边界改写、响应回写时还原。此前直接用客户端原始 id 登记——大量客户端
   * 每请求都从 `id:1` 重新编号，两个并发 POST 同 id 时后登记者覆盖前者，一方的响应帧
   * 写进另一方（`replies[0]` 变 undefined ⇒ TypeError ⇒ 500）。A2A 传输已用同一模式修复。
   * @param message 入站消息。
   * @returns 响应消息（id 已还原为客户端原始 id）；通知为 undefined。
   */
  private async dispatchOne(message: RpcMessage): Promise<RpcMessage | undefined> {
    if (!('method' in message) || !('id' in message)) {
      await this.mcp.handle(message);
      return undefined;
    }
    const serverKey: RequestId = `@srv-${(this.streamSeq += 1)}`;
    const replies: RpcMessage[] = [];
    this.transport.registerStream(serverKey, (frame) => {
      const parsed = jsonRpc.parse(frame.data);
      if (parsed !== undefined) replies.push(parsed);
    });
    try {
      await this.mcp.handle({ ...message, id: serverKey });
    } finally {
      this.transport.unregisterStream(serverKey);
    }
    const reply = replies[0];
    // 响应 id 还原为客户端原始 id（协议要求响应回显请求 id）。
    return reply === undefined ? undefined : ({ ...reply, id: message.id } as RpcMessage);
  }

  /**
   * 读取请求体（1 MiB 上限 + 读超时；超限/超时/断开都转成带状态码的错误）。
   * @param request 入站请求。
   * @returns UTF-8 请求体。
   * @throws McpHttpBodyError 超限（413）/超时（408）/读取失败（400）。
   */
  private readBody(request: IncomingMessage): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      let settled = false;
      const timer = setTimeout(() => {
        settle(() =>
          reject(
            new McpHttpBodyError(`读取请求体超时（${this.config.readTimeoutMs} ms）`, HTTP_TIMEOUT),
          ),
        );
      }, this.config.readTimeoutMs);
      timer.unref();
      const cleanup = (): void => {
        clearTimeout(timer);
        request.off('data', onData);
        request.off('end', onEnd);
        request.off('error', onError);
        request.off('aborted', onAborted);
      };
      const settle = (action: () => void): void => {
        if (settled) return;
        settled = true;
        cleanup();
        action();
      };
      const onData = (chunk: Buffer): void => {
        size += chunk.length;
        if (size > this.config.bodyLimitBytes) {
          settle(() =>
            reject(new McpHttpBodyError(`请求体超过 ${this.config.bodyLimitBytes} 字节上限`, 413)),
          );
          request.resume();
          return;
        }
        chunks.push(chunk);
      };
      const onEnd = (): void => {
        settle(() => resolve(Buffer.concat(chunks).toString('utf8')));
      };
      const onError = (error: Error): void => {
        settle(() => reject(new McpHttpBodyError(`读取请求体失败：${error.message}`, 400)));
      };
      const onAborted = (): void => {
        settle(() => reject(new McpHttpBodyError('客户端在请求体读完前断开', 400)));
      };
      request.on('data', onData);
      request.on('end', onEnd);
      request.on('error', onError);
      request.on('aborted', onAborted);
    });
  }

  /**
   * 回 JSON 响应（统一 `application/json; charset=utf-8` + Content-Length）。
   * @param response 响应对象。
   * @param status HTTP 状态码。
   * @param payload JSON 载荷。
   * @returns 无返回值。
   */
  private respondJson(response: ServerResponse, status: number, payload: unknown): void {
    const body = JSON.stringify(payload);
    response.statusCode = status;
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.setHeader('Content-Length', Buffer.byteLength(body));
    response.end(body);
  }

  /**
   * 回 JSON-RPC 错误（`id` 缺省为 null，符合传输层错误的惯例）。
   * @param response 响应对象。
   * @param status HTTP 状态码。
   * @param code JSON-RPC 错误码。
   * @param message 错误消息。
   * @param data 结构化附加信息（可选）。
   * @param id 关联请求 id（可选；传输层错误为 null）。
   * @returns 无返回值。
   */
  private respondError(
    response: ServerResponse,
    status: number,
    code: number,
    message: string,
    data?: unknown,
    id: number | string | null = null,
  ): void {
    this.respondJson(response, status, {
      jsonrpc: '2.0',
      id,
      error: { code, message, ...(data !== undefined ? { data } : {}) },
    });
  }

  /**
   * 关闭实现：结束订阅流 → 关闭 HTTP 服务器（并强制断开残留连接，避免 close 悬挂）。
   * @returns 关闭完成的 Promise。
   */
  private async shutdown(): Promise<void> {
    this.mcp.close();
    for (const response of [...this.sse.values()]) {
      if (!response.writableEnded) response.end();
    }
    this.sse.clear();
    if (!this.http.listening) return;
    await new Promise<void>((resolve, reject) => {
      this.http.close((error) => {
        if (error === undefined) resolve();
        else reject(error);
      });
      this.http.closeAllConnections();
    });
  }
}
