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
import type { RpcMessage } from '../server/jsonRpc.js';
import { JsonRpc } from '../server/jsonRpc.js';
import type { A2aTransport } from './a2aProtocol.js';
import { inspectUrl, assertNotSsrf, defaultSsrfOptions } from '../security/ssrfGuard.js';
import type { SsrfOptions } from '../security/ssrfGuard.js';
import { log } from '../util/logger.js';

/** 客户端 HTTP 传输：向对端端点发请求，响应经 onMessage 回传。 */
export class HttpA2aTransport implements A2aTransport {
  private callback: ((message: RpcMessage) => void) | undefined;
  private readonly endpoint: string;
  /** SSRF 策略：默认放行私有网段但拦截云元数据（出厂默认端点即 localhost/a2a）。 */
  private readonly ssrf: SsrfOptions;

  /**
   * @param endpoint 对端 `/a2a` 端点。
   * @param ssrf SSRF 策略覆盖；缺省用 {@link defaultSsrfOptions}。
   */
  public constructor(endpoint: string, ssrf?: SsrfOptions) {
    this.endpoint = endpoint;
    this.ssrf = ssrf ?? defaultSsrfOptions();
  }

  /**
   * 端点合法性校验（含可选 DNS 解析），命中 SSRF 规则即抛错。
   * 供持有方在建立连接前显式调用——配置错误必须显性暴露，
   * 绝不等到运行时把请求静默发到内网或云元数据服务。
   */
  public async validate(): Promise<void> {
    await assertNotSsrf(this.endpoint, this.ssrf);
  }

  public onMessage(callback: (message: RpcMessage) => void): void {
    this.callback = callback;
  }

  public send(message: RpcMessage): void {
    // 发送前同步拦截（字面量判定，零网络开销）；命中即不发请求（fail-closed）。
    const verdict = inspectUrl(this.endpoint, this.ssrf);
    if (verdict.blocked) {
      log.warn('a2a.ssrfBlocked', { endpoint: this.endpoint, reason: verdict.reason });
      return;
    }
    fetch(this.endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(message),
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

  public close(): void {}
}

/** 服务端 HTTP 传输：监听 POST /a2a，按 JSON-RPC id 关联回写响应。 */
export class HttpA2aServerTransport implements A2aTransport {
  private callback: ((message: RpcMessage) => void) | undefined;
  private readonly resolvers = new Map<number | string, (m: RpcMessage) => void>();
  private server: http.Server | undefined;

  public onMessage(callback: (message: RpcMessage) => void): void {
    this.callback = callback;
  }

  public send(message: RpcMessage): void {
    if ('id' in message) {
      const r = this.resolvers.get(message.id);
      if (r !== undefined) {
        this.resolvers.delete(message.id);
        r(message);
      }
    }
  }

  /** 在给定端口监听（返回实际端口）。 */
  public async listen(port: number): Promise<number> {
    this.server = http.createServer((req, res) => {
      if (req.method !== 'POST') {
        res.writeHead(405);
        res.end();
        return;
      }
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
      });
      req.on('end', () => {
        const msg = JsonRpc.parse(body);
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
        const promise = new Promise<RpcMessage>((resolve) => {
          this.resolvers.set(id, resolve);
        });
        this.callback?.(msg);
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
    });
    return new Promise((resolve) => {
      this.server!.listen(port, () => resolve(port));
    });
  }

  public close(): void {
    this.server?.close();
  }
}
