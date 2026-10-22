/**
 * MCP 客户端认证解析（端口 → 实现的第一片）。
 *
 * 口径：
 * - `bearer` / `oauth` 都消费**已有访问令牌**（配置值或环境变量），生成 `Authorization` 头；
 * - `oauth` 的 `resource`/`authorizationServer` 用于 RFC 9728 资源元数据发现与后续交互式授权；
 *   本片**不**发起浏览器授权码流（缺令牌即 fail-closed，不发匿名请求后静默失败）；
 * - 静态 `headers` 与认证头合并，认证头优先（避免配置里写死的旧 token 覆盖新 token）。
 */
import type { McpServerConfig } from '../ports/mcp/mcpServerConfig.ts';
import type { McpAuthConfig, McpProtectedResourceMetadata } from '../ports/mcp/mcpAuthConfig.ts';

/** 认证头缺失时抛出的可行动错误前缀。 */
export const MCP_AUTH_UNAVAILABLE = 'MCP_AUTH_UNAVAILABLE';

/**
 * MCP 认证解析器（无状态，可并发）。
 */
export class McpAuthProvider {
  /**
   * 解析请求头。
   * @param server 服务器配置。
   * @param env 环境变量（测试注入）。
   * @returns 请求头（含 Authorization，若配置了认证）。
   * @throws 认证令牌缺失/空白时抛 `MCP_AUTH_UNAVAILABLE: ...`。
   */
  public static headersOf(
    server: McpServerConfig,
    env: Record<string, string | undefined> = process.env,
  ): Record<string, string> {
    const headers: Record<string, string> = { ...(server.headers ?? {}) };
    if (server.auth === undefined || server.auth.type === 'none') {
      return headers;
    }
    const token = McpAuthProvider.tokenOf(server.auth, env);
    if (token === undefined) {
      throw new Error(
        `${MCP_AUTH_UNAVAILABLE}: 服务器 "${server.name}" 配置了 ${server.auth.type} 认证，但没有可用令牌；` +
          '请设置 token 或 tokenEnv 指向的环境变量（不要提交明文令牌）',
      );
    }
    for (const key of Object.keys(headers)) {
      if (key.toLowerCase() === 'authorization') delete headers[key];
    }
    headers['Authorization'] = `Bearer ${token}`;
    return headers;
  }

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
   * 取令牌：配置值优先，其次环境变量。
   * @param auth 认证配置。
   * @param env 环境变量。
   * @returns 非空令牌或 undefined。
   */
  private static tokenOf(
    auth: McpAuthConfig,
    env: Record<string, string | undefined>,
  ): string | undefined {
    if (auth.type === 'none') return undefined;
    const direct = auth.type === 'bearer' ? auth.token : auth.accessToken;
    if (direct !== undefined) {
      const trimmed = direct.trim();
      // 显式空令牌 = 配错了，不再静默回退到 tokenEnv（避免把「空值」当成「没配」）。
      return trimmed === '' ? undefined : trimmed;
    }
    const envName = auth.tokenEnv;
    if (envName === undefined) return undefined;
    const value = env[envName]?.trim();
    return value === '' ? undefined : value;
  }
}
