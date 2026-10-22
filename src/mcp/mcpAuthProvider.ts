/**
 * MCP 客户端认证解析（端口 → 实现的第一片）。
 *
 * 口径：
 * - `bearer` / `oauth` 消费**已有访问令牌**（配置值 / 环境变量 / `mcp auth` 写入的本机令牌存储），
 *   生成 `Authorization` 头；
 * - `oauth` 的 `resource`/`authorizationServer` 用于 RFC 9728 资源元数据发现；浏览器授权码流由
 *   `mcp auth` 跑，本类只读结果（缺令牌即 fail-closed，不发匿名请求后静默失败）；
 * - 静态 `headers` 与认证头合并，认证头优先（避免配置里写死的旧 token 覆盖新 token）。
 */
import type { McpServerConfig } from '../ports/mcp/mcpServerConfig.ts';
import type { McpProtectedResourceMetadata } from '../ports/mcp/mcpAuthConfig.ts';
import { McpOAuthTokenClient, type OAuthAccessToken } from './mcpOAuthTokenClient.ts';
import { McpAuthTokenStore } from './mcpAuthTokenStore.ts';

/** 认证头缺失时抛出的可行动错误前缀。 */
export const MCP_AUTH_UNAVAILABLE = 'MCP_AUTH_UNAVAILABLE';

/**
 * MCP 认证解析器（无状态，可并发）。
 */
export class McpAuthProvider {
  /**
   * 解析请求头（async：oauth client credentials 可能需要取令牌）。
   * @param server 服务器配置。
   * @param env 环境变量（测试注入）。
   * @param now 受控时钟（测试注入）。
   * @param fetchImpl fetch 注入（测试用）。
   * @returns 请求头（含 Authorization，若配置了认证）。
   * @throws 认证令牌缺失/空白时抛 `MCP_AUTH_UNAVAILABLE: ...`；令牌端点失败抛 `MCP_OAUTH_TOKEN_FAILED`。
   */
  public static async headersOf(
    server: McpServerConfig,
    env: Record<string, string | undefined> = process.env,
    now: number = Date.now(),
    fetchImpl: typeof fetch = fetch,
  ): Promise<Record<string, string>> {
    const headers: Record<string, string> = { ...(server.headers ?? {}) };
    if (server.auth === undefined || server.auth.type === 'none') {
      return headers;
    }
    const token = await McpAuthProvider.tokenOf(server, env, now, fetchImpl);
    if (token === undefined) {
      throw new Error(
        `${MCP_AUTH_UNAVAILABLE}: 服务器 "${server.name}" 配置了 ${server.auth.type} 认证，但没有可用令牌；` +
          '请设置 token/tokenEnv、先跑 `omniharness mcp auth`，或为 oauth 提供 tokenEndpoint + clientId + clientSecretEnv',
      );
    }
    for (const key of Object.keys(headers)) {
      if (key.toLowerCase() === 'authorization') delete headers[key];
    }
    headers['Authorization'] = `Bearer ${token}`;
    return headers;
  }

  /** 令牌缓存（按 server + tokenEndpoint + scopes；有界，避免长期运行无限增长）。 */
  private static readonly tokenCache = new Map<string, OAuthAccessToken>();

  /** 缓存上限。 */
  private static readonly MAX_CACHE = 50;

  /**
   * 通过 RFC 9728 发现受保护资源元数据。
   * @param resourceUrl 受保护资源 URL（MCP server url）。
   * @param fetchImpl fetch 注入（测试用）。
   * @returns 元数据。
   * @throws HTTP 非 2xx / JSON 非法 / 缺 resource 或 authorization_servers 时抛错。
   */
  public static async discoverProtectedResource(
    resourceUrl: string,
    fetchImpl: typeof fetch = fetch,
  ): Promise<McpProtectedResourceMetadata> {
    const base = new URL(resourceUrl);
    // RFC 9728 §3.1：把 well-known 后缀插在 host 与 path 之间
    // （`https://mcp.example/mcp` → `https://mcp.example/.well-known/oauth-protected-resource/mcp`）。
    const suffix = '/.well-known/oauth-protected-resource';
    const path = base.pathname === '/' ? '' : base.pathname.replace(/\/$/u, '');
    const metadataUrl = new URL(`${suffix}${path}`, base.origin);
    metadataUrl.search = base.search;
    const response = await fetchImpl(metadataUrl, {
      headers: { accept: 'application/json' },
    });
    if (!response.ok) {
      throw new Error(`MCP 资源元数据发现失败: HTTP ${String(response.status)}`);
    }
    const raw = (await response.json()) as unknown;
    if (typeof raw !== 'object' || raw === null) {
      throw new Error('MCP 资源元数据必须是 JSON 对象');
    }
    const record = raw as Record<string, unknown>;
    const resource = record['resource'];
    const servers = record['authorization_servers'];
    if (
      typeof resource !== 'string' ||
      !Array.isArray(servers) ||
      servers.some((entry) => typeof entry !== 'string')
    ) {
      throw new Error('MCP 资源元数据缺少 resource / authorization_servers');
    }
    // RFC 9728 §3.3：resource 必须与构造元数据 URL 的标识**逐字相同**。
    // 不做 URL 规范化比较——`https://MCP.EXAMPLE:443/mcp` 与 `https://mcp.example/mcp`
    // 规范化后相等，但它们是不同的标识符；接受其一就会放过冒名/跨租户元数据。
    if (resource !== resourceUrl) {
      throw new Error(
        `MCP 资源元数据 resource 不匹配（期望 ${resourceUrl}，实际 ${resource}）；按 RFC 9728 §3.3 拒绝使用`,
      );
    }
    const scopes = record['scopes_supported'];
    return {
      resource,
      authorizationServers: servers as readonly string[],
      ...(Array.isArray(scopes) && scopes.every((scope) => typeof scope === 'string')
        ? { scopesSupported: scopes as readonly string[] }
        : {}),
      raw,
    };
  }

  /**
   * 取令牌：直接值 > tokenEnv > oauth client credentials（带缓存）。
   * @param server 服务器配置（含 name，用于缓存键）。
   * @param env 环境变量。
   * @param now 受控时钟。
   * @param fetchImpl fetch 注入。
   * @returns 非空令牌或 undefined。
   */
  private static async tokenOf(
    server: McpServerConfig,
    env: Record<string, string | undefined>,
    now: number,
    fetchImpl: typeof fetch,
  ): Promise<string | undefined> {
    const auth = server.auth;
    if (auth === undefined || auth.type === 'none') return undefined;
    const direct = auth.type === 'bearer' ? auth.token : auth.accessToken;
    if (direct !== undefined) {
      const trimmed = direct.trim();
      // 显式空令牌 = 配错了，不再静默回退到 tokenEnv（避免把「空值」当成「没配」）。
      return trimmed === '' ? undefined : trimmed;
    }
    const envName = auth.tokenEnv;
    if (envName !== undefined) {
      const value = env[envName]?.trim();
      if (value !== undefined && value !== '') return value;
    }
    if (auth.type === 'oauth') {
      const resource = auth.resource ?? server.url;
      if (resource !== undefined) {
        const stored = new McpAuthTokenStore(
          env['OMNI_MCP_TOKENS_FILE'] ?? McpAuthTokenStore.defaultPath(),
        ).get(resource);
        if (
          stored !== undefined &&
          stored.accessToken.trim() !== '' &&
          stored.expiresAt > now + 30_000 &&
          (auth.clientId === undefined || stored.clientId === auth.clientId) &&
          (auth.tokenEndpoint === undefined || stored.tokenEndpoint === auth.tokenEndpoint)
        ) {
          return stored.accessToken;
        }
      }
    }
    if (auth.type !== 'oauth' || auth.tokenEndpoint === undefined || auth.clientId === undefined) {
      return undefined;
    }
    const secretRaw =
      auth.clientSecret !== undefined && auth.clientSecret.trim() !== ''
        ? auth.clientSecret
        : auth.clientSecretEnv !== undefined
          ? env[auth.clientSecretEnv]
          : undefined;
    const secret = secretRaw?.trim();
    if (secret === undefined || secret === '') return undefined;
    const key = [
      server.name,
      auth.tokenEndpoint,
      auth.clientId,
      auth.resource ?? '',
      (auth.scopes ?? []).join(' '),
    ].join('\0');
    const cached = McpAuthProvider.tokenCache.get(key);
    if (cached !== undefined && cached.expiresAt > now + 30_000) {
      return cached.accessToken;
    }
    const token = await McpOAuthTokenClient.clientCredentials(
      {
        tokenEndpoint: auth.tokenEndpoint,
        clientId: auth.clientId,
        clientSecret: secret,
        ...(auth.resource !== undefined ? { resource: auth.resource } : {}),
        ...(auth.scopes !== undefined ? { scopes: auth.scopes } : {}),
        fetchImpl,
      },
      now,
    );
    McpAuthProvider.tokenCache.set(key, token);
    while (McpAuthProvider.tokenCache.size > McpAuthProvider.MAX_CACHE) {
      const first = McpAuthProvider.tokenCache.keys().next().value;
      if (first === undefined) break;
      McpAuthProvider.tokenCache.delete(first);
    }
    return token.accessToken;
  }
}
