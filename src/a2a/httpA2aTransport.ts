/**
 * A2A HTTP 传输（U6 生产落地）。
 *
 * - `HttpA2aTransport`：客户端侧，向对端 `/a2a` 端点 POST JSON-RPC，把响应经
 *   `onMessage` 回传（供 A2aClient 的 id 关联）。
 * - `HttpA2aServerTransport`：服务端侧，起一个 `node:http` 服务监听 POST `/a2a`，
 *   把请求转交 A2aServer 处理，并据 JSON-RPC id 关联回写响应。
 *
 * 零依赖（仅 node:http / node:fetch）。鉴权由 A2aServer + AgentIdentityPort 负责。
 */
import http from 'node:http';
import type { RpcMessage } from '../server/core/jsonRpc.js';
import { jsonRpc } from '../server/core/jsonRpc.js';
import type { A2aTransport } from './a2aProtocol.js';
import { SsrfGuard } from '../security/ssrfGuard.js';
import type { SsrfOptions } from '../security/ssrfGuard.js';
import { log } from '../util/logger.js';
import { LimitEnv } from '../util/limitEnv.js';

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
      .catch(() => {
        /* 网络错误由对端超时/上层 fail-closed 处理 */
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
  /** 服务端唯一键的单调计数器（进程内唯一即可，不跨进程保证）。 */
  private seq = 0;
  /** 底层 node:http 服务实例（listen 后才有值）。 */
  private server: http.Server | undefined;

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
   * @param port 期望监听的端口（可传 0 取系统分配的临时端口）。
   * @returns **实际**监听的端口（由 `server.address()` 读取，port=0 时即临时端口）；
   *          仅接受 POST /a2a，其余返回 405/400/500。
   */
  public async listen(port: number): Promise<number> {
    this.server = http.createServer((req, res) => this.handleRequest(req, res));
    const server = this.server;
    return new Promise<number>((resolve) => {
      server.listen(port, () => {
        const address = server.address();
        resolve(typeof address === 'object' && address !== null ? address.port : port);
      });
    });
  }

  /**
   * 处理单条入站 HTTP 请求（POST /a2a）：带体积上限与读超时的 fail-closed 解析。
   *
   * @param req 入站请求。
   * @param res 响应对象。
   * @returns 无返回值。
   */
  private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    if (req.method !== 'POST') {
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
      if (aborted) {
        return;
      }
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
      const promise = new Promise<RpcMessage>((resolve) => {
        this.resolvers.set(key, { remoteId: id, resolve });
      });
      // 对端在响应前断开 ⇒ 该挂起项永远不会被回写，必须就地回收，否则长跑服务里逐请求泄漏
      // （审计 X4：原实现无 close 清理，resolver 与连接一起悬着）。
      res.on('close', () => {
        this.resolvers.delete(key);
      });
      this.callback?.({ ...msg, id: key });
      promise
        .then((response) => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify(response));
        })
        .catch(() => {
          res.writeHead(500);
          res.end();
        });
    });
  }

  /** 关闭传输：停止 HTTP 服务监听，释放端口。
   * @returns 无返回值。
   */
  public close(): void {
    this.server?.close();
  }
}
