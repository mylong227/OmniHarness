/**
 * MCP OAuth 令牌客户端（client credentials grant，2026-10-22 第二片）。
 *
 * 适用：服务账号 / 机器对机器的托管 MCP server（无用户交互）。浏览器授权码 + PKCE
 * 仍留给下一步的 `mcp auth` 命令；本类**不**伪造用户授权。
 *
 * 安全口径：client secret 优先从环境变量读；不打印/不回显 secret 与 token。
 */
export interface OAuthClientCredentialsRequest {
  /** 令牌端点（OAuth 2.1 token endpoint）。 */
  readonly tokenEndpoint: string;
  /** 客户端标识。 */
  readonly clientId: string;
  /** 客户端密钥（调用方负责从 env/保险库取）。 */
  readonly clientSecret: string;
  /** RFC 8707 resource。 */
  readonly resource?: string | undefined;
  /** 申请的 scope。 */
  readonly scopes?: readonly string[] | undefined;
  /** fetch 注入（测试用）。 */
  readonly fetchImpl?: typeof fetch | undefined;
}

/** 令牌结果（只保留本仓需要的字段）。 */
export interface OAuthAccessToken {
  /** 访问令牌。 */
  readonly accessToken: string;
  /** 绝对过期时间（毫秒；无 expires_in 时为 now + 5min）。 */
  readonly expiresAt: number;
  /** 令牌类型（通常 Bearer）。 */
  readonly tokenType: string;
  /** 可选刷新令牌。 */
  readonly refreshToken?: string | undefined;
}

/**
 * OAuth 令牌客户端（纯逻辑 + 可注入 fetch）。
 */
export class McpOAuthTokenClient {
  /** 缺省令牌有效期（端点未给 expires_in 时）。 */
  private static readonly DEFAULT_TTL_MS = 5 * 60 * 1000;

  /**
   * 用 client credentials 换访问令牌。
   * @param request 端点/客户端/scope。
   * @param now 受控时钟（测试注入）。
   * @returns 访问令牌。
   * @throws HTTP 非 2xx / JSON 非法 / 缺 access_token 时抛错（绝不返回空令牌）。
   */
  public static async clientCredentials(
    request: OAuthClientCredentialsRequest,
    now: number = Date.now(),
  ): Promise<OAuthAccessToken> {
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: request.clientId,
      client_secret: request.clientSecret,
    });
    if (request.resource !== undefined) body.set('resource', request.resource);
    if (request.scopes !== undefined && request.scopes.length > 0) {
      body.set('scope', request.scopes.join(' '));
    }
    const fetchImpl = request.fetchImpl ?? fetch;
    const response = await fetchImpl(request.tokenEndpoint, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: body.toString(),
      // token 请求会把 client_secret 放进 body：禁止跟随重定向，避免 307/308 跨源重放。
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      throw new Error(`MCP_OAUTH_TOKEN_FAILED: token endpoint HTTP ${String(response.status)}`);
    }
    let raw: unknown;
    try {
      raw = await response.json();
    } catch {
      throw new Error('MCP_OAUTH_TOKEN_FAILED: token endpoint 返回非 JSON');
    }
    if (typeof raw !== 'object' || raw === null) {
      throw new Error('MCP_OAUTH_TOKEN_FAILED: token 响应必须是对象');
    }
    const record = raw as Record<string, unknown>;
    const accessTokenRaw = record['access_token'];
    const accessToken = typeof accessTokenRaw === 'string' ? accessTokenRaw.trim() : '';
    if (accessToken === '') {
      throw new Error('MCP_OAUTH_TOKEN_FAILED: token 响应缺少 access_token');
    }
    const expiresIn = record['expires_in'];
    const ttl =
      typeof expiresIn === 'number' && Number.isFinite(expiresIn) && expiresIn > 0
        ? expiresIn * 1000
        : McpOAuthTokenClient.DEFAULT_TTL_MS;
    const tokenType =
      typeof record['token_type'] === 'string' && record['token_type'] !== ''
        ? record['token_type']
        : 'Bearer';
    const refreshToken =
      typeof record['refresh_token'] === 'string' ? record['refresh_token'] : undefined;
    return {
      accessToken,
      expiresAt: now + ttl,
      tokenType,
      ...(refreshToken !== undefined ? { refreshToken } : {}),
    };
  }
}
