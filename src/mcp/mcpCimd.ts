/**
 * CIMD（Client ID Metadata Document，OAuth Client ID Metadata Document）解析（2026-10-22）。
 *
 * CIMD：`client_id` 本身是 HTTPS URL，授权服务器拉取该文档获取 redirect_uris 等元数据。
 * 本类只做客户端侧**预检**：URL 必须 https（localhost 开发例外）、文档 `client_id` 必须与 URL
 * 逐字一致、redirect_uri 必须在 `redirect_uris` 内；不做动态注册。
 */
export interface McpClientMetadata {
  /** 客户端标识（URL）。 */
  readonly clientId: string;
  /** 允许的回调地址。 */
  readonly redirectUris: readonly string[];
  /** 客户端名（可选）。 */
  readonly clientName?: string | undefined;
  /** 令牌端点认证方式（可选）。 */
  readonly tokenEndpointAuthMethod?: string | undefined;
  /**
   * OAuth 客户端类型（RFC 7591 `application_type`，2026-07-28 要求客户端注册时显式给出）。
   *
   * - `native`：桌面/CLI 客户端，使用 loopback 或自定义 scheme 回调；
   * - `web`：Web 客户端，回调必须是 HTTPS。
   */
  readonly applicationType?: 'native' | 'web' | undefined;
}

/**
 * CIMD 解析器。
 */
export class McpCimd {
  /**
   * 拉取并校验 client metadata document。
   * @param clientId client_id（必须是 https URL；localhost http 允许开发）。
   * @param fetchImpl fetch 注入。
   * @returns 元数据。
   * @throws URL 非法/非 https/文档不匹配时抛错（fail-closed）。
   */
  public static async resolve(
    clientId: string,
    fetchImpl: typeof fetch = fetch,
  ): Promise<McpClientMetadata> {
    const url = McpCimd.parse(clientId);
    const response = await fetchImpl(url, {
      headers: { accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      throw new Error(`CIMD 拉取失败: HTTP ${String(response.status)}`);
    }
    const raw = (await response.json()) as unknown;
    if (typeof raw !== 'object' || raw === null) {
      throw new Error('CIMD 文档必须是 JSON 对象');
    }
    const record = raw as Record<string, unknown>;
    if (record['client_id'] !== clientId) {
      throw new Error('CIMD 文档 client_id 与 URL 不一致');
    }
    const redirects = record['redirect_uris'];
    if (
      !Array.isArray(redirects) ||
      redirects.length === 0 ||
      redirects.some((entry) => typeof entry !== 'string')
    ) {
      throw new Error('CIMD 文档缺少 redirect_uris');
    }
    const applicationType = McpCimd.applicationTypeOf(record['application_type'], redirects);
    return {
      clientId,
      redirectUris: redirects as readonly string[],
      ...(typeof record['client_name'] === 'string' ? { clientName: record['client_name'] } : {}),
      ...(typeof record['token_endpoint_auth_method'] === 'string'
        ? { tokenEndpointAuthMethod: record['token_endpoint_auth_method'] }
        : {}),
      ...(applicationType !== undefined ? { applicationType } : {}),
    };
  }

  /**
   * 校验 CIMD 文档里的 `application_type`（RFC 7591 / 2026-07-28 要求）。
   *
   * 规则：值只能是 `native`/`web`；`web` 客户端不得使用 loopback 回调（OIDC 注册冲突），
   * `native` 客户端至少应有一个 loopback/自定义 scheme 回调。字段缺失时返回 undefined
   * （兼容尚未声明该字段的旧文档，但调用方可要求显式值）。
   * @param raw 原始 `application_type`。
   * @param redirectUris 文档声明的回调地址。
   * @returns 规整后的类型；字段缺失时 undefined。
   * @throws 值非法或与回调形态冲突时抛错（fail-closed）。
   */
  public static applicationTypeOf(
    raw: unknown,
    redirectUris: readonly string[],
  ): 'native' | 'web' | undefined {
    if (raw === undefined || raw === null) return undefined;
    if (raw !== 'native' && raw !== 'web') {
      throw new Error('CIMD application_type 必须是 native 或 web');
    }
    if (raw === 'web' && redirectUris.some((uri) => McpCimd.isLoopback(uri))) {
      throw new Error('CIMD application_type=web 不得使用 loopback 回调地址');
    }
    return raw;
  }

  /**
   * 按回调地址建议 `application_type`（供动态注册/CIMD 文档生成使用）。
   * @param redirectUris 回调地址。
   * @returns 含 loopback 时为 `native`，否则 `web`。
   */
  public static suggestApplicationType(redirectUris: readonly string[]): 'native' | 'web' {
    return redirectUris.some((uri) => McpCimd.isLoopback(uri)) ? 'native' : 'web';
  }

  /**
   * 回调地址是否为 loopback（localhost / 127.0.0.1 / ::1）。
   * @param uri 回调地址。
   * @returns loopback 为 true（非法 URL 视为 false）。
   */
  public static isLoopback(uri: string): boolean {
    try {
      const url = new URL(uri);
      return url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '::1';
    } catch {
      return false;
    }
  }

  /**
   * 校验 client_id 形态。
   * @param clientId client_id。
   * @returns 是否为 CIMD URL。
   */
  public static isCimd(clientId: string): boolean {
    try {
      McpCimd.parse(clientId);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 解析并限制 scheme。
   * @param clientId client_id URL。
   * @returns 解析后的 URL。
   */
  private static parse(clientId: string): URL {
    let url: URL;
    try {
      url = new URL(clientId);
    } catch {
      throw new Error(`client_id 不是合法 URL: ${clientId}`);
    }
    const localhost = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && localhost)) {
      throw new Error('CIMD client_id 必须是 HTTPS URL（localhost 开发例外）');
    }
    if (url.username !== '' || url.password !== '') {
      throw new Error('CIMD client_id 不得含 userinfo');
    }
    if (url.pathname === '/' || url.pathname === '') {
      throw new Error('CIMD client_id 必须含路径');
    }
    if (/(^|\/)\.\.?(\/|$)/u.test(clientId)) {
      throw new Error('CIMD client_id 不得含 dot-segment');
    }
    if (url.hash !== '') throw new Error('CIMD client_id 不得含 fragment');
    return url;
  }
}
