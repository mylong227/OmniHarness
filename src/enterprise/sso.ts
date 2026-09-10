import crypto from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

/**
 * 企业级 SSO（OIDC）零依赖实现（D2）。
 *
 * 设计约束：
 * - 纯 TypeScript + 仅 `node:` 内置（`crypto`/`fs`/`url`），零运行时依赖，守住项目铁律。
 * - 仅实现授权码流 + PKCE(S256) + RS256 JWKS 签名校验，覆盖企业接入的最小完备集。
 * - fail-closed：`authenticate()` 任何校验失败一律返回 `null`（视为未认证），绝不静默放行。
 *
 * 运行时验证边界：本模块代码可在 Windows 本机编译/单测（用注入 fetch + 本地 RSA 密钥），
 * 但**真实接入某 IdP** 需目标 IdP 元数据与可达网络，属外部设施，需单独排期。
 *
 * OOP 收敛（2026-09-10）：原 9 个顶层导出函数收拢为 `OidcClient` 静态方法族，
 * 原导出名以 `export const` 门面别名保留（签名不变，调用点零改动）；`EnterpriseAuth` 门禁委托 `OidcClient`。
 */

/**
 * @beta
 * OIDC 提供方配置。
 */
export interface OidcProviderConfig {
  /** Issuer（如 https://accounts.example.com），将拼接 /.well-known/openid-configuration。 */
  readonly issuer: string;
  /** 在 IdP 注册的应用 client_id。 */
  readonly clientId: string;
  /**  confidential client 的 client_secret（public client 可省略）。 */
  readonly clientSecret?: string;
  /** 回调地址（需与 IdP 注册一致）。 */
  readonly redirectUri?: string;
  /** 申请的 scope，默认 `openid profile email`。 */
  readonly scope?: string;
}

/**
 * @beta
 * OIDC discovery 文档的已校验子集。
 */
export interface OidcDiscovery {
  readonly issuer: string;
  readonly authorization_endpoint: string;
  readonly token_endpoint: string;
  readonly jwks_uri?: string;
  readonly userinfo_endpoint?: string;
}

/**
 * @beta
 * PKCE(S256) 密钥对。
 */
export interface PkcePair {
  readonly verifier: string;
  readonly challenge: string;
  readonly method: 'S256';
}

/**
 * @beta
 * 授权码换得的令牌集。
 */
export interface TokenSet {
  readonly access_token: string;
  readonly id_token?: string;
  readonly token_type: string;
  readonly expires_in?: number;
  readonly refresh_token?: string;
  readonly scope?: string;
}

/**
 * @beta
 * JWK（仅取 RS256 校验所需字段）。
 */
export interface Jwk {
  readonly kty: string;
  readonly n?: string;
  readonly e?: string;
  readonly alg?: string;
  readonly kid?: string;
  readonly use?: string;
}

/**
 * @beta
 * 解码后的 JWT 三部件。
 */
export interface JwtParts {
  readonly header: Record<string, unknown>;
  readonly payload: Record<string, unknown>;
  readonly signature: string;
  readonly signingInput: string;
}

/**
 * @beta
 * `auth login` 持久化的中间态（state + verifier + 配置），供 `auth callback` 续跑。
 */
export interface AuthState {
  readonly issuer: string;
  readonly clientId: string;
  readonly clientSecret?: string;
  readonly redirectUri?: string;
  readonly scope?: string;
  readonly state: string;
  readonly codeVerifier: string;
  readonly createdAt: string;
}

// ---------------------------------------------------------------------------
// OIDC 客户端：OAuth/OIDC 流程族（纯函数 + 内聚操作）收敛为静态方法族
// ---------------------------------------------------------------------------

/**
 * @beta
 * OIDC 客户端流程族：discovery / PKCE / 授权 URL / 换码 / JWT 解码与校验 / CLI 中间态持久化。
 * 全部为静态方法（无隐式状态），原模块级导出名以门面别名保留，调用点零改动。
 */
export class OidcClient {
  private static b64url(input: Buffer | string): string {
    return Buffer.from(input)
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
  }

  private static b64urlToBuf(s: string): Buffer {
    return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  }

  private static b64urlDecode(s: string): string {
    return OidcClient.b64urlToBuf(s).toString('utf8');
  }

  /** 拉取并校验 OIDC discovery 文档。 */
  static async fetchDiscovery(
    issuer: string,
    fetchImpl: typeof fetch = globalThis.fetch,
  ): Promise<OidcDiscovery> {
    const base = issuer.replace(/\/+$/, '');
    const res = await fetchImpl(`${base}/.well-known/openid-configuration`, {
      headers: { accept: 'application/json' },
    });
    if (!res.ok) {
      throw new Error(`OIDC discovery 失败: ${res.status} ${res.statusText}`);
    }
    const doc = (await res.json()) as Record<string, unknown>;
    const authorization_endpoint = doc['authorization_endpoint'];
    const token_endpoint = doc['token_endpoint'];
    if (typeof authorization_endpoint !== 'string' || typeof token_endpoint !== 'string') {
      throw new Error('OIDC discovery 缺少必需端点 authorization_endpoint / token_endpoint');
    }
    return {
      issuer: typeof doc['issuer'] === 'string' ? doc['issuer'] : base,
      authorization_endpoint,
      token_endpoint,
      jwks_uri: typeof doc['jwks_uri'] === 'string' ? doc['jwks_uri'] : undefined,
      userinfo_endpoint:
        typeof doc['userinfo_endpoint'] === 'string' ? doc['userinfo_endpoint'] : undefined,
    };
  }

  /**
   * @beta
   * 生成 PKCE(S256) 密钥对：verifier 为 32 字节随机 base64url，challenge = SHA256(verifier) base64url。
   */
  static generatePkcePair(): PkcePair {
    const verifier = OidcClient.b64url(crypto.randomBytes(32));
    const challenge = OidcClient.b64url(crypto.createHash('sha256').update(verifier).digest());
    return { verifier, challenge, method: 'S256' };
  }

  /**
   * @beta
   * 构造授权码流授权 URL（含 PKCE + state + nonce）。
   */
  static buildAuthorizationUrl(
    discovery: OidcDiscovery,
    config: OidcProviderConfig,
    params: { readonly state: string; readonly codeChallenge: string; readonly scope?: string },
  ): string {
    const u = new URL(discovery.authorization_endpoint);
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('client_id', config.clientId);
    if (config.redirectUri !== undefined) u.searchParams.set('redirect_uri', config.redirectUri);
    u.searchParams.set('scope', params.scope ?? config.scope ?? 'openid profile email');
    u.searchParams.set('state', params.state);
    u.searchParams.set('code_challenge', params.codeChallenge);
    u.searchParams.set('code_challenge_method', 'S256');
    u.searchParams.set('nonce', crypto.randomBytes(8).toString('hex'));
    return u.toString();
  }

  /** 用授权码换取令牌集（支持 public/confidential client，PKCE 校验）。 */
  static async exchangeCode(
    discovery: OidcDiscovery,
    config: OidcProviderConfig,
    params: {
      readonly code: string;
      readonly codeVerifier?: string;
      readonly redirectUri?: string;
      readonly fetchImpl?: typeof fetch;
    },
  ): Promise<TokenSet> {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code: params.code,
      client_id: config.clientId,
      redirect_uri: params.redirectUri ?? config.redirectUri ?? '',
    });
    if (config.clientSecret !== undefined) body.set('client_secret', config.clientSecret);
    if (params.codeVerifier !== undefined) body.set('code_verifier', params.codeVerifier);
    const res = await (params.fetchImpl ?? globalThis.fetch)(discovery.token_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: body.toString(),
    });
    if (!res.ok) {
      throw new Error(`OIDC token 交换失败: ${res.status} ${res.statusText}`);
    }
    const json = (await res.json()) as Record<string, unknown>;
    const access_token = json['access_token'];
    if (typeof access_token !== 'string') {
      throw new Error('OIDC token 响应缺少 access_token');
    }
    return {
      access_token,
      id_token: typeof json['id_token'] === 'string' ? json['id_token'] : undefined,
      token_type: typeof json['token_type'] === 'string' ? json['token_type'] : 'Bearer',
      expires_in: typeof json['expires_in'] === 'number' ? json['expires_in'] : undefined,
      refresh_token: typeof json['refresh_token'] === 'string' ? json['refresh_token'] : undefined,
      scope: typeof json['scope'] === 'string' ? json['scope'] : undefined,
    };
  }

  /**
   * @beta
   * 解码 JWT（不校验签名），返回 header/payload/signature/signingInput。
   */
  static decodeJwt(token: string): JwtParts {
    const parts = token.split('.');
    if (parts.length !== 3) throw new Error('非法 JWT：段数不为 3');
    const header = JSON.parse(OidcClient.b64urlDecode(parts[0]!)) as Record<string, unknown>;
    const payload = JSON.parse(OidcClient.b64urlDecode(parts[1]!)) as Record<string, unknown>;
    return {
      header,
      payload,
      signature: parts[2]!,
      signingInput: `${parts[0]}.${parts[1]}`,
    };
  }

  /**
   * @beta
   * 校验 id_token 的 iss/aud/exp/nonce 声明（不含签名）。
   */
  static verifyIdTokenClaims(
    payload: Record<string, unknown>,
    opts: { readonly issuer: string; readonly clientId: string; readonly nonce?: string },
  ): void {
    const iss = payload['iss'];
    if (iss !== opts.issuer) throw new Error(`id_token iss 不匹配: ${String(iss)} != ${opts.issuer}`);
    const aud = payload['aud'];
    const okAud =
      typeof aud === 'string'
        ? aud === opts.clientId
        : Array.isArray(aud)
          ? aud.includes(opts.clientId)
          : false;
    if (!okAud) throw new Error('id_token aud 不匹配 client_id');
    const exp = payload['exp'];
    if (typeof exp === 'number' && Date.now() / 1000 > exp) throw new Error('id_token 已过期');
    if (opts.nonce !== undefined && payload['nonce'] !== opts.nonce)
      throw new Error('id_token nonce 不匹配');
  }

  /**
   * @beta
   * 用 RS256 JWKS 校验 JWT 签名。
   */
  static verifyJwtSignature(token: string, jwks: { readonly keys: readonly Jwk[] }): void {
    const { header, signature, signingInput } = OidcClient.decodeJwt(token);
    if (header['alg'] !== 'RS256')
      throw new Error(`仅支持 RS256 签名，收到: ${String(header['alg'])}`);
    const kid = header['kid'];
    const key = jwks.keys.find((k) => k.kid === kid && k.kty === 'RSA');
    if (key === undefined || key.n === undefined || key.e === undefined) {
      throw new Error('找不到匹配的 RSA JWK');
    }
    const pub = crypto.createPublicKey({
      key: { kty: 'RSA', n: key.n, e: key.e },
      format: 'jwk',
    });
    const ok = crypto.verify(
      'RSA-SHA256',
      Buffer.from(signingInput),
      pub,
      OidcClient.b64urlToBuf(signature),
    );
    if (!ok) throw new Error('id_token 签名校验失败');
  }

  /**
   * @beta
   * 写入 `auth login` 中间态到文件（state + verifier + 配置）。
   */
  static writeAuthState(path: string, state: AuthState): void {
    writeFileSync(path, JSON.stringify(state, null, 2), 'utf8');
  }

  /**
   * @beta
   * 读取 `auth login` 中间态。
   */
  static readAuthState(path: string): AuthState {
    return JSON.parse(readFileSync(path, 'utf8')) as AuthState;
  }
}

// 门面别名：保留原模块级导出名与签名，调用点零改动。
export const fetchDiscovery = OidcClient.fetchDiscovery;
export const generatePkcePair = OidcClient.generatePkcePair;
export const buildAuthorizationUrl = OidcClient.buildAuthorizationUrl;
export const exchangeCode = OidcClient.exchangeCode;
export const decodeJwt = OidcClient.decodeJwt;
export const verifyIdTokenClaims = OidcClient.verifyIdTokenClaims;
export const verifyJwtSignature = OidcClient.verifyJwtSignature;
export const writeAuthState = OidcClient.writeAuthState;
export const readAuthState = OidcClient.readAuthState;

// ---------------------------------------------------------------------------
// 认证门禁
// ---------------------------------------------------------------------------

/**
 * @beta
 * 企业认证门禁：持有 discovery + 可重载 JWKS，校验 Bearer 令牌并返回主体。fail-closed。
 */
export class EnterpriseAuth {
  private jwksCache: { readonly keys: readonly Jwk[]; readonly fetchedAt: number } | undefined;

  constructor(
    private readonly config: OidcProviderConfig,
    private readonly discovery: OidcDiscovery,
    private readonly fetchImpl: typeof fetch = globalThis.fetch,
  ) {}

  /** 从 issuer 拉 discovery 构造门禁。 */
  static async fromIssuer(
    config: OidcProviderConfig,
    fetchImpl: typeof fetch = globalThis.fetch,
  ): Promise<EnterpriseAuth> {
    const discovery = await OidcClient.fetchDiscovery(config.issuer, fetchImpl);
    return new EnterpriseAuth(config, discovery, fetchImpl);
  }

  /** 校验 Authorization 头中的 Bearer 令牌；任何失败返回 null（未认证）。 */
  async authenticate(
    header: string | undefined,
  ): Promise<{ readonly sub: string; readonly claims: Record<string, unknown> } | null> {
    if (header === undefined) return null;
    const m = /^Bearer\s+(.+)$/i.exec(header.trim());
    if (m === null) return null;
    const token = m[1]!;
    try {
      const decoded = OidcClient.decodeJwt(token);
      if (decoded.header['alg'] !== 'RS256') return null;
      if (this.discovery.jwks_uri === undefined) return null;
      const jwks = await this.getJwks();
      OidcClient.verifyJwtSignature(token, jwks);
      OidcClient.verifyIdTokenClaims(decoded.payload, {
        issuer: this.discovery.issuer,
        clientId: this.config.clientId,
      });
      const sub = decoded.payload['sub'];
      if (typeof sub !== 'string') return null;
      return { sub, claims: decoded.payload };
    } catch {
      return null;
    }
  }

  private async getJwks(): Promise<{ readonly keys: readonly Jwk[] }> {
    if (this.jwksCache !== undefined && Date.now() - this.jwksCache.fetchedAt < 3_600_000)
      return this.jwksCache;
    if (this.discovery.jwks_uri === undefined) throw new Error('discovery 未提供 jwks_uri');
    const res = await this.fetchImpl(this.discovery.jwks_uri, {
      headers: { accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`JWKS 获取失败: ${res.status}`);
    const doc = (await res.json()) as { keys?: readonly Jwk[] };
    const keys = doc.keys ?? [];
    this.jwksCache = { keys, fetchedAt: Date.now() };
    return this.jwksCache;
  }
}
