/**
 * 零依赖本地 OIDC IdP fixture（F4 更优解验证用）。
 *
 * 设计动机：
 * - `src/enterprise/oidcClient.ts` 的 `OidcClient` / `EnterpriseAuth` 是零依赖、fetch 可注入的
 *   纯实现，但"真实接入某 IdP"此前被标为外部设施（keycloak 容器 / 可达网络），导致整条
 *   认证门禁无法端到端验证。
 * - 本 fixture 用 `node:crypto` + `node:http` 起一个**合规最小 IdP**：签发**真实 RS256 JWT**
 *   （非 stub），serve discovery / JWKS / token 三个端点。它让 `EnterpriseAuth.authenticate`
 *   走完整真实密码学链路（discovery → JWKS → RS256 验签 → iss/aud/exp 校验），而**不需要
 *   keycloak、不需要 docker、不需要外部网络、不引入任何运行时依赖**。
 * - 这是 `panva/node-oidc-provider`（OpenID 认证的参考实现，已认证 OP Basic/Implicit/Hybrid/
 *   Config/Dynamic）思路的零依赖复刻：我们只复刻验证 `OidcClient` 所必需的子集，把"真实 IdP"
 *   变成可随单测启动的进程内设施。保真度等价（真实 JWT + 真实 JWKS），效率更高（毫秒级、无容器）。
 *
 * 仅用于测试，不进入生产代码路径。
 */
import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

/** IdP 签发的 JWK 公钥子集（RS256 校验所需字段）。 */
interface RsaPublicJwk {
  readonly kty: 'RSA';
  readonly n: string;
  readonly e: string;
}

/**
 * @beta
 * 零依赖 OIDC 测试 IdP：签发真实 RS256 id_token，暴露 discovery / JWKS / token 端点。
 */
export class OidcFixture {
  /** 固定 kid（JWKS 与签名共用，便于 `OidcClient` 按 kid 匹配）。 */
  private readonly kid = 'omni-test-kid-1';
  /** HTTP 服务实例（start 后存在）。 */
  private server: http.Server | undefined;
  /** 已分配的 issuer（含随机端口）。 */
  private issuer = '';
  /** RSA 私钥（签发 id_token 用），构造时生成。 */
  private privateKey: crypto.KeyObject;
  /** RSA 公钥（JWKS 暴露用，base64url n/e），构造时生成。 */
  private publicJwk: RsaPublicJwk;

  /**
   * 构造时生成 RSA 密钥对（仅密钥生成，不启动服务）。
   */
  public constructor() {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    this.privateKey = privateKey;
    const jwk = publicKey.export({ format: 'jwk' }) as { n?: string; e?: string };
    this.publicJwk = { kty: 'RSA', n: jwk.n ?? '', e: jwk.e ?? '' };
  }

  /**
   * 启动本地 IdP 服务（监听 127.0.0.1 随机端口）。
   * @returns 无返回值；启动后可通过 `issuerUrl` 取端点基址。
   */
  public async start(): Promise<void> {
    const server = http.createServer((req, res) => this.handle(req, res));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    this.server = server;
    const addr = server.address() as AddressInfo;
    this.issuer = `http://127.0.0.1:${addr.port}`;
  }

  /**
   * 取 IdP issuer 基址（如 http://127.0.0.1:54321）。
   * @returns issuer URL。
   */
  public get issuerUrl(): string {
    return this.issuer;
  }

  /**
   * 关闭 IdP 服务。
   * @returns 服务关闭完成的 Promise。
   */
  public async close(): Promise<void> {
    const server = this.server;
    if (server === undefined) return;
    // 断开 fetch 的 keep-alive 连接，否则 server.close 回调因存活 socket 永不触发，
    // 导致 node --test 事件循环不空而挂死。
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    this.server = undefined;
  }

  /**
   * 为指定 client 签发真实 RS256 id_token（可被 `OidcClient.verifyJwtSignature` 验过）。
   * @param opts 签发参数：sub 主体、clientId 受众、expiresInSec 有效期（默认 3600）。
   * @returns 形如 header.payload.signature 的 JWT 字符串。
   */
  public issueIdToken(opts: {
    readonly sub: string;
    readonly clientId: string;
    readonly expiresInSec?: number;
  }): string {
    const now = Math.floor(Date.now() / 1000);
    const exp = now + (opts.expiresInSec ?? 3600);
    const header = { alg: 'RS256', kid: this.kid, typ: 'JWT' };
    const payload = {
      iss: this.issuer,
      sub: opts.sub,
      aud: opts.clientId,
      exp,
      iat: now,
    };
    const signingInput = `${this.b64url(JSON.stringify(header))}.${this.b64url(JSON.stringify(payload))}`;
    const sig = crypto.sign('RSA-SHA256', Buffer.from(signingInput), this.privateKey);
    return `${signingInput}.${this.b64url(sig)}`;
  }

  /**
   * 处理 discovery / JWKS / token 三类端点请求。
   * @param req 入站请求。
   * @param res 响应对象。
   * @returns 无返回值。
   */
  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    const host = req.headers.host;
    const hostStr = Array.isArray(host) ? host[0] : (host ?? 'localhost');
    const url = `http://${hostStr}${req.url ?? ''}`;
    const path = new URL(url).pathname;
    if (req.method === 'GET' && path === '/.well-known/openid-configuration') {
      this.sendJson(res, 200, {
        issuer: this.issuer,
        authorization_endpoint: `${this.issuer}/authorize`,
        token_endpoint: `${this.issuer}/token`,
        jwks_uri: `${this.issuer}/jwks`,
        userinfo_endpoint: `${this.issuer}/userinfo`,
        id_token_signing_alg_values_supported: ['RS256'],
        response_types_supported: ['code'],
      });
      return;
    }
    if (req.method === 'GET' && path === '/jwks') {
      this.sendJson(res, 200, {
        keys: [{ use: 'sig', alg: 'RS256', kid: this.kid, ...this.publicJwk }],
      });
      return;
    }
    if (req.method === 'POST' && path === '/token') {
      this.readBody(req).then((body) => {
        const params = new URLSearchParams(body);
        const clientId = params.get('client_id') ?? 'test-client';
        // 真实 IdP 会校验 code + PKCE；此处仅签发令牌（code 不透明，测试已模拟登录）。
        const idToken = this.issueIdToken({ sub: 'user-123', clientId });
        this.sendJson(res, 200, {
          access_token: `omni-access-${crypto.randomBytes(8).toString('hex')}`,
          id_token: idToken,
          token_type: 'Bearer',
          expires_in: 3600,
        });
      });
      return;
    }
    this.sendJson(res, 404, { error: 'not_found' });
  }

  /**
   * 读取请求体（UTF-8）。
   * @param req 入站请求。
   * @returns 完整请求体文本。
   */
  private async readBody(req: http.IncomingMessage): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    return Buffer.concat(chunks).toString('utf8');
  }

  /**
   * 写 JSON 响应。
   * @param res 响应对象。
   * @param status HTTP 状态码。
   * @param body 任意可序列化对象。
   * @returns 无返回值。
   */
  private sendJson(res: http.ServerResponse, status: number, body: unknown): void {
    const text = JSON.stringify(body);
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(text);
  }

  /**
   * 将字节编码为无填充 base64url 字符串（JWT 标准字母表）。
   * @param input 待编码的 Buffer 或对象（对象会先 JSON 化）。
   * @returns base64url 字符串。
   */
  private b64url(input: Buffer | string | object): string {
    const buf = Buffer.isBuffer(input)
      ? input
      : Buffer.from(typeof input === 'string' ? input : JSON.stringify(input));
    return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
}
