/**
 * A2A HTTP 传输（U6 生产落地）。
 *
 * - `HttpA2aTransport`：客户端侧，向对端 `/a2a` 端点 POST JSON-RPC，把响应经
 *   `onMessage` 回传（供 A2aClient 的 id 关联）。
 * - `HttpA2aServerTransport`：服务端侧，起一个 `node:http` 服务监听 POST `/a2a`，
 *   把请求转交 A2aServer 处理，并据 JSON-RPC id 关联回写响应。
 *
 * 无第三方依赖（仅 node:http / node:fetch）。鉴权由 A2aServer + AgentIdentityPort 负责。
 */
import http from 'node:http';
import type { RpcMessage } from '../server/core/jsonRpc.ts';
import { jsonRpc } from '../server/core/jsonRpc.ts';
import type { A2aTransport } from './a2aProtocol.ts';
import { A2A_MESSAGE_STREAM, A2A_TASKS_RESUBSCRIBE, A2A_TASKS_SUBSCRIBE } from './a2aProtocol.ts';
import { SsrfGuard } from '../security/ssrfGuard.ts';
import type { SsrfOptions } from '../security/ssrfGuard.ts';
import { log } from '../util/logger.ts';
import { LimitEnv } from '../util/limitEnv.ts';

/** 客户端 HTTP 传输：向对端端点发请求，响应经 onMessage 回传。 */
export class HttpA2aTransport implements A2aTransport {
  /** 响应回调（经 {@link onMessage} 注册；未注册时响应被丢弃）。 */
  private callback: ((message: RpcMessage) => void) | undefined;
  /** 对端 `/a2a` 端点 URL（构造时固定）。 */
  private readonly endpoint: string;
  /** SSRF 策略：默认放行私有网段但拦截云元数据（出厂默认端点即 localhost/a2a）。 */
  private readonly ssrf: SsrfOptions;
  /** 出站 `send` 的空闲超时（毫秒，可由 `OMNI_A2A_SEND_TIMEOUT_MS` 覆盖）：fire-and-forget 也必须释放 socket。 */
  private static readonly SEND_TIMEOUT_MS = LimitEnv.int('OMNI_A2A_SEND_TIMEOUT_MS', 10_000);

  /**
   * @param endpoint 对端 `/a2a` 端点。
   * @param ssrf SSRF 策略覆盖；缺省用 {@link defaultSsrfOptions}。
   */
  public constructor(endpoint: string, ssrf?: SsrfOptions) {
    this.endpoint = endpoint;
    this.ssrf = ssrf ?? SsrfGuard.defaultSsrfOptions();
  }

  /**
   * 端点合法性校验（含可选 DNS 解析），命中 SSRF 规则即抛错。
   * 供持有方在建立连接前显式调用——配置错误必须显性暴露，
   * 绝不等到运行时把请求静默发到内网或云元数据服务。
   
   * @returns 无返回值。
   */
  public async validate(): Promise<void> {
    await SsrfGuard.assertNotSsrf(this.endpoint, this.ssrf);
  }

  /**
   * 订阅入站消息：注册回调，HTTP 响应解析为 JSON-RPC 后经此回传（供 A2aClient 按 id 关联）。
   * @param callback 收到响应消息时的处理回调（重复注册以最后一次为准）。
   
   * @returns 无返回值。
   */
  public onMessage(callback: (message: RpcMessage) => void): void {
    this.callback = callback;
  }

  /**
   * 发送一条消息：向端点 POST JSON-RPC，响应解析后经 {@link onMessage} 回传。
   * 发送前同步做 SSRF 字面量拦截，命中即丢弃不发（fail-closed）；网络错误静默吞掉，由上层超时兜底。
   *
   * @param message 待发送的 JSON-RPC 消息（请求/响应/通知）。
   
   * @returns 无返回值。
   */
  public send(message: RpcMessage): void {
    // 发送前同步拦截（字面量判定，零网络开销）；命中即不发请求（fail-closed）。
    const verdict = SsrfGuard.inspectUrl(this.endpoint, this.ssrf);
    if (verdict.blocked) {
      log.warn('a2a.ssrfBlocked', { endpoint: this.endpoint, reason: verdict.reason });
      return;
    }
    fetch(this.endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(message),
      signal: AbortSignal.timeout(HttpA2aTransport.SEND_TIMEOUT_MS),
    })
      .then((r) => r.json())
      .then((resp: unknown) => {
        if (this.callback !== undefined && typeof resp === 'object' && resp !== null) {
          this.callback(resp as RpcMessage);
        }
      })
      .catch((error: unknown) => {
        // 网络错误由对端超时/上层 fail-closed 兜底，但零观测会让「对端配错/宕机」表现为
        // 永远静默超时（2026-10-27 审计 #13）——至少留一条 debug 轨迹。
        log.debug('a2a.send.failed', {
          endpoint: this.endpoint,
          error: error instanceof Error ? error.message : String(error),
        });
      });
  }

  /** 关闭传输：客户端无持久连接（fetch 单次请求即弃），no-op。
   * @returns 无返回值。
   */
  public close(): void {}
}

/** 服务端 HTTP 传输：监听 POST /a2a，按 JSON-RPC id 关联回写响应。 */
export class HttpA2aServerTransport implements A2aTransport {
  /** 入站请求处理回调（经 {@link onMessage} 注册，通常是 A2aServer 的处理入口）。 */
  private callback: ((message: RpcMessage) => void) | undefined;
  /**
   * **服务端唯一**路由键 → 挂起请求。
   *
   * 为什么不能用客户端给的 JSON-RPC id 当键（2026-09-26 审计 S1，P0）：每个 `A2aClient`
   * 的 id 都**从 1 开始编号**，两个对端并发进来必然撞 id —— 后到的 `set` 覆盖前一个 resolver，
   * 于是「一方拿到别人的响应、另一方永久挂起」。故入库时把 id 改写成服务端唯一键再交给
   * 处理回调，回写时按唯一键查表、还原对端的原始 id 再回响应。
   */
  private readonly resolvers = new Map<
    string,
    { readonly remoteId: number | string; readonly resolve: (m: RpcMessage) => void }
  >();
  /**
   * 流式响应通道（同一 JSON-RPC id 的多条响应 → SSE）。
   *
   * 与 `resolvers` 分开存放：单响应与流式响应的收尾条件不同（前者首条即删，后者要等到
   * `final:true` 或错误响应），混在一张表里极易把后续事件写进已结束的响应。
   */
  private readonly streams = new Map<string, http.ServerResponse>();
  /** 服务端唯一键的单调计数器（进程内唯一即可，不跨进程保证）。 */
  private seq = 0;
  /** 底层 node:http 服务实例（listen 后才有值）。 */
  private server: http.Server | undefined;
  /** AgentCard（设置后暴露 `/.well-known/agent-card.json`）。 */
  private card: unknown;
  /** AgentCard 动态提供者（优先于静态 card；用于返回签名卡并与 JSON-RPC 取卡同源）。 */
  private cardProvider: (() => Promise<unknown> | unknown) | undefined;

  /**
   * 设置 AgentCard（与 A2aServer 的 card 同步；well-known 路由只读暴露）。
   * @param card A2A AgentCard。
   * @returns 无返回值。
   */
  public setAgentCard(card: unknown): void {
    this.card = card;
  }

  /**
   * 设置 AgentCard 动态提供者（每次请求现取；用于返回带 JWS 签名的卡）。
   *
   * 提供者优先于 {@link setAgentCard}：签名卡的有效期/密钥轮换由提供者决定，
   * 静态缓存会发出过期签名。提供者抛错时 well-known 返回 500（fail-closed，不回落到旧卡）。
   * @param provider 返回 AgentCard（或 Promise）的回调。
   * @returns 无返回值。
   */
  public setAgentCardProvider(provider: () => Promise<unknown> | unknown): void {
    this.cardProvider = provider;
  }

  /**
   * 订阅入站消息：注册处理回调，服务端收到的 POST /a2a 请求体经此转交（如 A2aServer 处理）。
   * @param callback 收到入站请求消息时的处理回调（重复注册以最后一次为准）。
   
   * @returns 无返回值。
   */
  public onMessage(callback: (message: RpcMessage) => void): void {
    this.callback = callback;
  }

  /**
   * 发送一条消息：按**服务端唯一键**关联到挂起的 HTTP 请求并以其回写响应。
   * 无匹配键（通知/未知 id）时静默丢弃。
   *
   * @param message 待回写的 JSON-RPC 消息（id 须为本传输在入库时改写的唯一键）。
   
   * @returns 无返回值。
   */
  public send(message: RpcMessage): void {
    if (!('id' in message)) {
      return;
    }
    const key = String(message.id);
    const stream = this.streams.get(key);
    if (stream !== undefined) {
      this.writeStream(key, stream, message);
      return;
    }
    const entry = this.resolvers.get(key);
    if (entry === undefined) {
      return;
    }
    this.resolvers.delete(key);
    // 还原**对端**的原始 id 再回响应：否则对端按自己的 id 关联会匹配不上。
    entry.resolve({ ...message, id: entry.remoteId });
  }

  /** 入站请求体字节上限（fail-closed，可由 `OMNI_A2A_MAX_BODY_BYTES` 覆盖）：JSON-RPC 委托消息体量很小，1 MiB 已是极宽松上界。 */
  private static readonly MAX_BODY_BYTES = LimitEnv.int('OMNI_A2A_MAX_BODY_BYTES', 1_048_576);
  /** 入站读超时（毫秒，可由 `OMNI_A2A_READ_TIMEOUT_MS` 覆盖）：对端慢速/不发数据时必须释放连接，不能长期占用。 */
  private static readonly READ_TIMEOUT_MS = LimitEnv.int('OMNI_A2A_READ_TIMEOUT_MS', 30_000);

  /**
   * 在给定端口监听（返回实际端口）。
   *
   * 2026-10-21：默认只绑 **127.0.0.1**（此前 `listen(port)` 绑 `0.0.0.0`，同网段可免认证
   * 委托只读工具）。确需局域网互操作时用 `OMNI_A2A_HOST=0.0.0.0` 显式放行，并务必配置身份。
   * @param port 期望监听的端口（可传 0 取系统分配的临时端口）。
   * @returns **实际**监听的端口（由 `server.address()` 读取，port=0 时即临时端口）；
   *          仅接受 POST /a2a，其余返回 405/400/500。
   */
  public async listen(port: number): Promise<number> {
    this.server = http.createServer((req, res) => {
      // 客户端提前断开（RST/半关闭）时写响应触发 'error'；无监听会被 Node 22 升级为
      // uncaughtException 终止进程（httpServer.ts 同一课）。
      res.on('error', () => {});
      this.handleRequest(req, res);
    });
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

  /**
   * 处理 AgentCard well-known 路由（支持动态提供者；任何失败都 500，不回落到旧卡）。
   * @param res 响应对象。
   * @returns 无返回值（异步完成响应）。
   */
  private async serveAgentCard(res: http.ServerResponse): Promise<void> {
    try {
      const card = this.cardProvider !== undefined ? await this.cardProvider() : this.card;
      if (card === undefined) {
        HttpA2aServerTransport.respond(res, 404);
        return;
      }
      // A2A 1.0 §8.6：AgentCard 变化频率低，应给出缓存提示（客户端可据此条件请求）。
      HttpA2aServerTransport.respond(res, 200, JSON.stringify(card), {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'public, max-age=300',
      });
    } catch (error) {
      log.warn('a2a.card.wellKnown.failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      HttpA2aServerTransport.respond(res, 500);
    }
  }

  /**
   * 写一个简单响应（客户端已断开时静默放弃，避免异步路径产生未处理拒绝）。
   * @param res 响应对象。
   * @param status HTTP 状态码。
   * @param body 响应体（可选）。
   * @param headers 额外响应头（可选）。
   * @returns 无返回值。
   */
  private static respond(
    res: http.ServerResponse,
    status: number,
    body?: string,
    headers?: http.OutgoingHttpHeaders,
  ): void {
    if (res.writableEnded || res.destroyed) return;
    try {
      res.writeHead(status, headers);
      res.end(body);
    } catch {
      /* 对端在写回前断开：连接已不可用，无可回写 */
    }
  }

  /**
   * 判断是否 AgentCard well-known 请求。
   * @param req 入站请求。
   * @returns 命中 GET `/.well-known/agent-card.json` 时为 true。
   */
  private static isAgentCardRequest(req: http.IncomingMessage): boolean {
    return req.method === 'GET' && req.url === '/.well-known/agent-card.json';
  }

  /**
   * 处理单条入站 HTTP 请求（POST /a2a）：带体积上限与读超时的 fail-closed 解析。
   *
   * @param req 入站请求。
   * @param res 响应对象。
   * @returns 无返回值。
   */
  private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    if (HttpA2aServerTransport.isAgentCardRequest(req)) {
      void this.serveAgentCard(res);
      return;
    }
    if (req.method !== 'POST' || req.url !== '/a2a') {
      res.writeHead(405);
      res.end();
      return;
    }
    const chunks: Buffer[] = [];
    let received = 0;
    let aborted = false;
    // 入站读超时 + 体积上限（fail-closed）：A2A 服务端是网络端口，对端不可信，裸
    // `body += chunk` 既无体积上限也无读超时 ⇒ 超大/慢速请求可耗尽内存或长期占用连接。
    req.socket.setTimeout(HttpA2aServerTransport.READ_TIMEOUT_MS);
    req.socket.on('timeout', () => {
      if (!aborted) {
        aborted = true;
        req.destroy();
      }
    });
    req.on('data', (chunk: Buffer) => {
      if (aborted) {
        return;
      }
      received += chunk.length;
      if (received > HttpA2aServerTransport.MAX_BODY_BYTES) {
        aborted = true;
        res.writeHead(413, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('request body too large');
        // 排空剩余请求体并释放连接：不得 `req.destroy()`（会在响应发出前断连，
        // 让客户端收不到 413）；`aborted` 已保证后续分片不再累积进内存。
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (aborted) return;
      this.handleBody(req, res, chunks);
    });
  }

  /**
   * 解析已读入的请求体并分发（JSON-RPC / SSE）。
   * @param req 入站请求（用于认证头）。
   * @param res 响应对象。
   * @param chunks 已读入的请求体分片。
   * @returns 无返回值。
   */
  private handleBody(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    chunks: readonly Buffer[],
  ): void {
    const body = Buffer.concat(chunks).toString('utf8');
    const msg = jsonRpc.parse(body);
    if (msg === undefined || !('method' in msg)) {
      res.writeHead(400);
      res.end();
      return;
    }
    const id = 'id' in msg ? msg.id : null;
    if (id === null) {
      res.writeHead(400);
      res.end();
      return;
    }
    this.seq += 1;
    const key = `a2a-${String(this.seq)}`;
    // HTTP `Authorization` 原文注入 `params.assertion`：A2A 1.0 的认证在绑定层，
    // JSON-RPC 请求体本身不带凭据；不注入则真实客户端按规范发 Bearer/AgentAssertion
    // 头时，服务端永远判「缺失签名」。
    const enriched = HttpA2aServerTransport.attachAuthorization(msg, req);
    if (HttpA2aServerTransport.isStreaming(msg.method)) {
      this.openStream(key, res);
      this.callback?.({ ...enriched, id: key });
      return;
    }
    const promise = new Promise<RpcMessage>((resolve) => {
      this.resolvers.set(key, { remoteId: id, resolve });
    });
    // 对端在响应前断开 ⇒ 该挂起项永远不会被回写，必须就地回收，否则长跑服务里逐请求泄漏
    // （审计 X4：原实现无 close 清理，resolver 与连接一起悬着）。
    res.on('close', () => {
      this.resolvers.delete(key);
    });
    this.callback?.({ ...enriched, id: key });
    promise
      .then((response) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(response));
      })
      .catch(() => {
        res.writeHead(500);
        res.end();
      });
  }

  /**
   * 开启 SSE 流式响应（同一 JSON-RPC id 的多条响应逐条 `data:` 写出）。
   * @param key 服务端唯一键。
   * @param res 响应对象。
   * @returns 无返回值。
   */
  private openStream(key: string, res: http.ServerResponse): void {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.flushHeaders();
    this.streams.set(key, res);
    res.on('close', () => {
      this.streams.delete(key);
    });
  }

  /**
   * 写一条 SSE 事件；`final:true`（或错误响应）后结束流并回收。
   * @param key 服务端唯一键。
   * @param res 响应对象。
   * @param message JSON-RPC 响应。
   * @returns 无返回值。
   */
  private writeStream(key: string, res: http.ServerResponse, message: RpcMessage): void {
    if (res.writableEnded) {
      this.streams.delete(key);
      return;
    }
    res.write(`data: ${JSON.stringify(message)}\n\n`);
    if (HttpA2aServerTransport.isFinal(message)) {
      res.end();
      this.streams.delete(key);
    }
  }

  /**
   * 判断消息是否为某条流式逻辑的最后一条。
   * @param message JSON-RPC 响应。
   * @returns 错误响应，或 `statusUpdate.final` / `artifactUpdate.final` 为 true 时为 true。
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
   * 是否流式方法（同一 id 的多条响应）。
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
   * 把 HTTP `Authorization` 头注入请求参数的 `assertion`（不覆盖已有值）。
   * @param message 解析后的 JSON-RPC 消息。
   * @param req 入站请求。
   * @returns 注入后的消息。
   */
  private static attachAuthorization(message: RpcMessage, req: http.IncomingMessage): RpcMessage {
    const authorization = req.headers['authorization'];
    if (typeof authorization !== 'string' || authorization.trim() === '') return message;
    const params = (message as { readonly params?: unknown }).params;
    const record =
      typeof params === 'object' && params !== null && !Array.isArray(params)
        ? { ...(params as Record<string, unknown>) }
        : {};
    if (record['assertion'] === undefined) record['assertion'] = authorization;
    return { ...message, params: record } as RpcMessage;
  }

  /** 关闭传输：结束全部 SSE 流并停止 HTTP 服务监听，释放端口。
   * @returns 无返回值。
   */
  public close(): void {
    for (const response of this.streams.values()) {
      if (!response.writableEnded) response.end();
    }
    this.streams.clear();
    this.server?.close();
  }
}
